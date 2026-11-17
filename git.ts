// git smart HTTP: protocol v2 and v0 upload-pack, v0 receive-pack, packfile read/write,
// pkt-lines and side-band-64k. Node stdlib only; no git binary.

import { createHash } from 'node:crypto';
import { createInflate } from 'node:zlib';
import {
  ZERO_OID, VIEWER_NAME, VIEWER_EMAIL,
  type GitObject, type ObjType, type Repo,
  sha1, storeObject, getCommit, parseTree, buildTree, fileMapOf,
  reachableCommits, isAncestor, packEntry,
} from './store.ts';

export const AGENT = 'forge/1.0.0';

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

function pktStr(s: string): Buffer {
  return pktLine(s);
}

/** Split a buffer into pkt-line packets; returns packets and the unconsumed rest. */
export function parsePktLines(buf: Buffer): { packets: Array<{ kind: 'data' | 'flush' | 'delim'; payload: Buffer }>; rest: Buffer } {
  const packets: Array<{ kind: 'data' | 'flush' | 'delim'; payload: Buffer }> = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (len < 4 || i + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { packets, rest: buf.subarray(i) };
}

// --------------------------------------------------------------------------------------------
// Packfiles.
// --------------------------------------------------------------------------------------------

export function writePack(repo: Repo, oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const entry = packEntry(repo, oid);
    if (entry) parts.push(entry);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function inflateOne(input: Buffer): Promise<{ data: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const inf = createInflate();
    const chunks: Buffer[] = [];
    inf.on('data', (c: Buffer) => chunks.push(c));
    inf.on('error', reject);
    inf.on('end', () => resolve({ data: Buffer.concat(chunks), consumed: inf.bytesWritten }));
    inf.end(input);
  });
}

interface PackEntryRaw {
  type: ObjType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

function readVarint(buf: Buffer, pos: number, withType: boolean): { value: number; type: number; next: number } {
  let b = buf[pos];
  let value = withType ? b & 0x0f : b & 0x7f;
  let type = withType ? (b >> 4) & 0x07 : 0;
  let shift = withType ? 4 : 7;
  let next = pos + 1;
  while (b & 0x80) {
    b = buf[next];
    next += 1;
    value |= (b & 0x7f) << shift;
    shift += 7;
  }
  return { value, type, next };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    let b: number;
    do {
      b = delta[p];
      p += 1;
      value |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return value;
  };
  const srcSize = readSize();
  const dstSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (p < delta.length) {
    const op = delta[p];
    p += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { cpOff |= delta[p] << (8 * i); p += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { cpSize |= delta[p] << (8 * i); p += 1; }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(p, p + op));
      total += op;
      p += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== dstSize || total !== dstSize) throw new Error('delta target size mismatch');
  return result;
}

/** Parse a packfile; resolveBase finds a base object outside the pack (the repo store). */
export async function readPack(
  buf: Buffer,
  resolveBase: (oid: string) => GitObject | undefined,
): Promise<{ objects: Map<string, GitObject>; deltaCount: number }> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  // Trailer check: SHA-1 of all preceding bytes must equal the last 20.
  if (buf.length >= 20) {
    const expected = buf.subarray(buf.length - 20).toString('hex');
    const actual = sha1(buf.subarray(0, buf.length - 20));
    if (expected !== actual) throw new Error('pack trailer checksum mismatch');
  }
  const typeNames: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  const raws: PackEntryRaw[] = [];
  const offsets: number[] = [];
  const byOffset = new Map<number, GitObject>();
  const objects = new Map<string, GitObject>();
  let deltaCount = 0;
  let pos = 12;
  for (let n = 0; n < count; n += 1) {
    const entryStart = pos;
    offsets.push(entryStart);
    const { value: size, type, next } = readVarint(buf, pos, true);
    pos = next;
    let raw: PackEntryRaw;
    if (type === 6) {
      // OFS_DELTA: offset varint, base is entryStart - offset.
      let b = buf[pos];
      pos += 1;
      let offset = b & 0x7f;
      while (b & 0x80) {
        b = buf[pos];
        pos += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      const { data, consumed } = await inflateOne(buf.subarray(pos));
      if (data.length !== size) throw new Error('ofs-delta inflated size mismatch');
      pos += consumed;
      raw = { type: 'ofs-delta', data, baseOffset: entryStart - offset };
    } else if (type === 7) {
      const baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const { data, consumed } = await inflateOne(buf.subarray(pos));
      if (data.length !== size) throw new Error('ref-delta inflated size mismatch');
      pos += consumed;
      raw = { type: 'ref-delta', data, baseOid };
    } else {
      const typeName = typeNames[type];
      if (!typeName) throw new Error(`unknown pack object type ${type}`);
      const { data, consumed } = await inflateOne(buf.subarray(pos));
      if (data.length !== size) throw new Error('object inflated size mismatch');
      pos += consumed;
      raw = { type: typeName, data };
    }
    raws.push(raw);
  }
  const oidOf = (obj: GitObject): string => {
    const header = Buffer.from(`${obj.type} ${obj.data.length}\0`, 'utf8');
    return sha1(Buffer.concat([header, obj.data]));
  };
  const resolve = (raw: PackEntryRaw): GitObject => {
    if (raw.type === 'ofs-delta' || raw.type === 'ref-delta') {
      deltaCount += 1;
      let base: GitObject | undefined;
      if (raw.type === 'ofs-delta') base = byOffset.get(raw.baseOffset as number);
      else base = objects.get(raw.baseOid as string) ?? resolveBase(raw.baseOid as string);
      if (!base) throw new Error('delta base not found');
      const data = applyDelta(base.data, raw.data);
      return { type: base.type, data };
    }
    return { type: raw.type as ObjType, data: raw.data };
  };
  // First pass: plain objects (so delta bases in the pack are available). Second pass: deltas.
  for (let n = 0; n < count; n += 1) {
    if (raws[n].type === 'ofs-delta' || raws[n].type === 'ref-delta') continue;
    const obj = resolve(raws[n]);
    objects.set(oidOf(obj), obj);
    byOffset.set(offsets[n], obj);
  }
  for (let n = 0; n < count; n += 1) {
    if (raws[n].type !== 'ofs-delta' && raws[n].type !== 'ref-delta') continue;
    const obj = resolve(raws[n]);
    objects.set(oidOf(obj), obj);
    byOffset.set(offsets[n], obj);
  }
  return { objects, deltaCount };
}

// --------------------------------------------------------------------------------------------
// Fetch object selection.
// --------------------------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot?: string[];
  filter?: string;
  done?: boolean;
}

export interface FetchSelection {
  oids: string[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
  ready: boolean;
  wantedRefs: Array<{ oid: string; ref: string }>;
}

function peelToCommit(repo: Repo, oid: string): string | null {
  let cur = oid;
  for (let i = 0; i < 8; i += 1) {
    const obj = repo.objects.get(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (!m) return null;
      cur = m[1];
      continue;
    }
    return null;
  }
  return null;
}

export function selectFetch(repo: Repo, req: FetchRequest): FetchSelection {
  const shallowSet = new Set(req.shallow);
  const wantCommits: string[] = [];
  const extraObjects = new Set<string>();
  for (const want of new Set(req.wants)) {
    const commit = peelToCommit(repo, want);
    if (commit) {
      wantCommits.push(commit);
      if (commit !== want) extraObjects.add(want); // the tag object itself
    } else if (repo.objects.has(want)) {
      extraObjects.add(want);
    }
  }
  // Held set: reachable from haves, but a shallow boundary's parents are not held.
  const held = new Set<string>();
  {
    const stack = [...req.haves];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (held.has(oid)) continue;
      const commit = getCommit(repo, oid);
      if (!commit) continue;
      held.add(oid);
      if (shallowSet.has(oid)) continue;
      for (const parent of commit.parents) stack.push(parent);
    }
  }
  for (const ref of req.deepenNot ?? []) {
    const tip = repo.refs.get(ref) ?? (repo.objects.has(ref) ? ref : undefined);
    if (tip) for (const oid of reachableCommits(repo, [tip])) held.add(oid);
  }
  const since = req.deepenSince;
  const recentEnough = (oid: string): boolean => {
    if (since === undefined) return true;
    const c = getCommit(repo, oid);
    return (c?.committerTime ?? 0) >= since;
  };

  // Every object the client already holds: the trees and blobs of the held commits.
  const heldObjects = new Set<string>();
  for (const oid of held) {
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    const walk = (treeOid: string): void => {
      const obj = repo.objects.get(treeOid);
      if (!obj || obj.type !== 'tree') return;
      heldObjects.add(treeOid);
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '40000') walk(entry.oid);
        else heldObjects.add(entry.oid);
      }
    };
    walk(commit.tree);
  }

  const included = new Set<string>();
  let maxDistance = new Map<string, number>();
  if (req.depth !== undefined) {
    // BFS from the wants, limited to distance < depth.
    const dist = new Map<string, number>();
    const queue: string[] = [];
    for (const tip of wantCommits) {
      if (!dist.has(tip)) { dist.set(tip, 0); queue.push(tip); }
    }
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      const d = dist.get(oid) as number;
      if (d >= (req.depth as number)) continue;
      if (!recentEnough(oid)) continue;
      included.add(oid);
      const commit = getCommit(repo, oid);
      if (!commit) continue;
      for (const parent of commit.parents) {
        if (!dist.has(parent)) { dist.set(parent, d + 1); queue.push(parent); }
      }
    }
    maxDistance = dist;
    // Never re-send a commit the client already holds.
    for (const oid of held) included.delete(oid);
  } else {
    const reachable = reachableCommits(repo, wantCommits);
    for (const oid of reachable) {
      if (!held.has(oid) && recentEnough(oid)) included.add(oid);
    }
  }

  // Shallow / unshallow lines for the reply: a boundary stops being one when every parent
  // of the boundary commit will be present on the client after this fetch; a commit at
  // the depth limit stays shallow unless its parents are present anyway.
  const present = new Set<string>([...included, ...held]);
  const parentsPresent = (oid: string): boolean => {
    const commit = getCommit(repo, oid);
    return commit === null || commit.parents.every((p) => present.has(p));
  };
  const shallowOut = new Set<string>();
  const unshallowOut = new Set<string>();
  const reachableFromWants = reachableCommits(repo, wantCommits);
  for (const s of shallowSet) {
    if (!reachableFromWants.has(s)) continue;
    if (parentsPresent(s)) unshallowOut.add(s);
    else shallowOut.add(s);
  }
  if (req.depth !== undefined) {
    for (const oid of included) {
      if ((maxDistance.get(oid) ?? -1) === (req.depth as number) - 1 && !parentsPresent(oid) && !unshallowOut.has(oid)) {
        shallowOut.add(oid);
      }
    }
  }

  // ACKs: haves that are ancestors-or-equal of a want.
  const acks: string[] = [];
  for (const have of req.haves) {
    if (reachableFromWants.has(have)) acks.push(have);
  }
  const nak = req.haves.length === 0 ? true : acks.length === 0;
  const ready = req.haves.length > 0 && acks.length > 0 && wantCommits.every((w) => {
    // A want is satisfied when it is held (reachable from a have).
    return held.has(w);
  });

  // Collect objects: commits, then their trees/blobs; tags and directly-wanted objects too.
  // Nothing the client already holds is re-sent.
  const oids: string[] = [];
  const seen = new Set<string>();
  const add = (oid: string): void => {
    if (!seen.has(oid) && repo.objects.has(oid) && !heldObjects.has(oid)) { seen.add(oid); oids.push(oid); }
  };
  const filter = req.filter ?? '';
  const skipBlobs = filter === 'blob:none' || filter === 'tree:0';
  const skipTrees = filter === 'tree:0';
  const blobLimit = /^blob:limit=(\d+)$/.exec(filter);
  for (const oid of extraObjects) add(oid);
  const orderedCommits = [...included];
  for (const oid of orderedCommits) add(oid);
  for (const oid of orderedCommits) {
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    const walk = (treeOid: string): void => {
      const obj = repo.objects.get(treeOid);
      if (!obj || obj.type !== 'tree') return;
      if (!skipTrees) add(treeOid);
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '40000') walk(entry.oid);
        else {
          const blob = repo.objects.get(entry.oid);
          if (!blob) continue;
          if (skipBlobs) continue;
          if (blobLimit && blob.data.length > Number(blobLimit[1])) continue;
          add(entry.oid);
        }
      }
    };
    walk(commit.tree);
  }

  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  const wantSet = new Set(req.wants);
  const refNames = [...repo.refs.keys()].sort();
  for (const name of refNames) {
    const oid = repo.refs.get(name) as string;
    if (wantSet.has(oid)) wantedRefs.push({ oid, ref: name });
  }
  return {
    oids,
    shallow: [...shallowOut],
    unshallow: [...unshallowOut],
    acks,
    nak,
    ready,
    wantedRefs,
  };
}

// --------------------------------------------------------------------------------------------
// Sideband.
// --------------------------------------------------------------------------------------------

function sideband(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65500;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const slice = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) {
    // A packfile section must carry at least one sideband packet.
    out.push(pktLine(Buffer.from([1])));
  }
  return out;
}

// --------------------------------------------------------------------------------------------
// Advertisements.
// --------------------------------------------------------------------------------------------

const UPLOAD_CAPS_V0 = [
  'symref=HEAD:refs/heads/main',
  'multi_ack', 'thin-pack', 'side-band', 'side-band-64k', 'ofs-delta', 'shallow',
  'deepen-since', 'deepen-not', 'deepen-relative', 'no-progress', 'include-tag',
  'multi_ack_detailed', 'allow-tip-sha1-in-want', 'allow-reachable-sha1-in-want',
  'no-done', 'filter', 'agent=forge/1.0.0',
].join(' ');
const RECEIVE_CAPS_V0 = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', 'agent=forge/1.0.0'].join(' ');

function refLinesV0(repo: Repo, caps: string, headFirst: boolean): Buffer[] {
  const out: Buffer[] = [];
  const head = repo.refs.get('refs/heads/main');
  const names = [...repo.refs.keys()].sort();
  if (names.length === 0) {
    out.push(pktStr(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return out;
  }
  const first = headFirst && head ? `HEAD` : names[0];
  if (headFirst && head) {
    out.push(pktStr(`${head} HEAD\0${caps}\n`));
  } else {
    out.push(pktStr(`${repo.refs.get(first) as string} ${first}\0${caps}\n`));
  }
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    out.push(pktStr(`${oid} ${name}\n`));
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      const target = peelToCommit(repo, oid);
      if (target) out.push(pktStr(`${target} ${name}^{}\n`));
    }
  }
  return out;
}

export function infoRefsBody(repo: Repo | null, service: 'git-upload-pack' | 'git-receive-pack', gitProtocol: string): Buffer | null {
  if (!repo) return null;
  const serviceLine = pktStr(`# service=${service}\n`);
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    const caps = [
      'version 2',
      `agent=${AGENT}`,
      'ls-refs=unborn',
      'fetch=shallow filter',
      'object-format=sha1',
      'server-option',
    ];
    return Buffer.concat([serviceLine, FLUSH, ...caps.map((c) => pktStr(`${c}\n`)), FLUSH]);
  }
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  return Buffer.concat([serviceLine, FLUSH, ...refLinesV0(repo, caps, true), FLUSH]);
}

// --------------------------------------------------------------------------------------------
// upload-pack.
// --------------------------------------------------------------------------------------------

function parseFetchRequestV2(body: Buffer): FetchRequest | null {
  const { packets } = parsePktLines(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [] };
  let sawCommand = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'command=fetch') { sawCommand = true; continue; }
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.depth = Number(line.slice(7).trim());
    else if (line.startsWith('deepen-since ')) req.deepenSince = Number(line.slice(13).trim());
    else if (line.startsWith('deepen-not ')) { (req.deepenNot ??= []).push(line.slice(11).trim()); }
    else if (line.startsWith('filter ')) req.filter = line.slice(7).trim();
    else if (line === 'done') req.done = true;
  }
  return sawCommand ? req : null;
}

function parseFetchRequestV0(body: Buffer): FetchRequest | null {
  const { packets } = parsePktLines(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [] };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') { section += 1; continue; }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        req.wants.push(rest.split(' ')[0].trim());
      } else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) req.depth = Number(line.slice(7).trim());
      else if (line.startsWith('deepen-since ')) req.deepenSince = Number(line.slice(13).trim());
      else if (line.startsWith('deepen-not ')) { (req.deepenNot ??= []).push(line.slice(11).trim()); }
    } else {
      if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    }
  }
  return req.wants.length > 0 ? req : null;
}

export function handleUploadPack(repo: Repo, body: Buffer, gitProtocol: string): Buffer | null {
  const isV2 = gitProtocol === 'version=2';
  const req = isV2 ? parseFetchRequestV2(body) : parseFetchRequestV0(body);
  if (!req) return null;
  const sel = selectFetch(repo, req);
  // The pack for a selection is a pure function of the reachable object graph, which only
  // grows: cache the bytes so repeated identical fetches (the clone workload) are a lookup.
  const packKey = JSON.stringify([
    [...req.wants].sort(),
    [...req.haves].sort(),
    [...req.shallow].sort(),
    req.depth ?? null,
    req.deepenSince ?? null,
    [...(req.deepenNot ?? [])].sort(),
    req.filter ?? '',
  ]);
  let pack = repo.packCache.get(packKey);
  if (pack === undefined) {
    pack = writePack(repo, sel.oids);
    repo.packCache.set(packKey, pack);
    if (repo.packCache.size > 8) {
      const first = repo.packCache.keys().next().value;
      if (first !== undefined) repo.packCache.delete(first);
    }
  }
  if (isV2) {
    // Protocol v2 fetch responses carry only the sections that have content: the
    // acknowledgments section appears only while the client is still negotiating
    // (it sent haves without `done`); a client that sent `done` goes straight to
    // the shallow-info (when there are boundaries) and packfile sections. Real
    // git never sends wanted-refs for a fetch, so neither do we.
    const out: Buffer[] = [];
    if (!req.done) {
      out.push(pktStr('acknowledgments\n'));
      if (sel.nak) out.push(pktStr('NAK\n'));
      else {
        for (const ack of sel.acks) out.push(pktStr(`ACK ${ack}\n`));
        if (sel.ready) out.push(pktStr('ready\n'));
      }
      out.push(DELIM);
    }
    if (sel.shallow.length > 0 || sel.unshallow.length > 0) {
      out.push(pktStr('shallow-info\n'));
      for (const oid of sel.shallow) out.push(pktStr(`shallow ${oid}\n`));
      for (const oid of sel.unshallow) out.push(pktStr(`unshallow ${oid}\n`));
      out.push(DELIM);
    }
    out.push(pktStr('packfile\n'));
    out.push(...sideband(pack));
    out.push(FLUSH);
    return Buffer.concat(out);
  }
  const out: Buffer[] = [];
  if (sel.nak) out.push(pktStr('NAK\n'));
  else for (const ack of sel.acks) out.push(pktStr(`ACK ${ack}\n`));
  for (const oid of sel.shallow) out.push(pktStr(`shallow ${oid}\n`));
  for (const oid of sel.unshallow) out.push(pktStr(`unshallow ${oid}\n`));
  out.push(...sideband(pack));
  out.push(FLUSH);
  return Buffer.concat(out);
}

// --------------------------------------------------------------------------------------------
// ls-refs (v2).
// --------------------------------------------------------------------------------------------

export function handleLsRefs(repo: Repo, body: Buffer): Buffer | null {
  const { packets } = parsePktLines(body);
  let sawCommand = false;
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'command=ls-refs') { sawCommand = true; continue; }
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
  }
  if (!sawCommand) return null;
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: Buffer[] = [];
  const head = repo.refs.get('refs/heads/main');
  const names = [...repo.refs.keys()].sort();
  if (names.length === 0) {
    if (unborn) {
      out.push(pktStr(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
    out.push(FLUSH);
    return Buffer.concat(out);
  }
  if (head && keep('HEAD')) {
    out.push(pktStr(`${head} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
  }
  for (const name of names) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    const obj = repo.objects.get(oid);
    if (peel && obj && obj.type === 'tag') {
      const target = peelToCommit(repo, oid);
      if (target) line += ` peeled:${target}`;
    }
    out.push(pktStr(`${line}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

// --------------------------------------------------------------------------------------------
// receive-pack.
// --------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export async function handleReceivePack(repo: Repo, body: Buffer): Promise<Buffer> {
  const { packets, rest } = parsePktLines(body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  const report: string[] = [];
  let unpackOk = false;
  let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      const { objects } = await readPack(rest, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
        repo.packEntryCache.delete(oid);
      }
      unpackOk = true;
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  } else {
    unpackOk = true;
  }
  if (unpackOk) report.push('unpack ok');
  else report.push(`unpack ${unpackDetail}`);
  for (const cmd of commands) {
    if (!unpackOk) {
      report.push(`ng ${cmd.ref} unpack failed`);
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) report.push(`ng ${cmd.ref} non-fast-forward`);
      else if (current !== cmd.oldOid) report.push(`ng ${cmd.ref} non-fast-forward`);
      else {
        repo.refs.delete(cmd.ref);
        report.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        report.push(`ng ${cmd.ref} already exists`);
        continue;
      }
      if (!repo.objects.has(cmd.newOid)) {
        report.push(`ng ${cmd.ref} object not found`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      report.push(`ok ${cmd.ref}`);
      continue;
    }
    // Update: old must match, and the move must be a fast-forward.
    if (current === undefined || current !== cmd.oldOid) {
      report.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    if (!repo.objects.has(cmd.newOid)) {
      report.push(`ng ${cmd.ref} object not found`);
      continue;
    }
    const oldCommit = peelToCommit(repo, cmd.oldOid) ?? cmd.oldOid;
    const newCommit = peelToCommit(repo, cmd.newOid) ?? cmd.newOid;
    if (cmd.newOid !== cmd.oldOid && !isAncestor(repo, oldCommit, newCommit)) {
      report.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    report.push(`ok ${cmd.ref}`);
  }
  // The report-status stream inside band 1 is itself pkt-line framed and ends with its own
  // flush packet; the sideband packets carry chunks of that stream, and an outer flush
  // terminates the response.
  const stream = Buffer.concat([...report.map((line) => pktLine(`${line}\n`)), FLUSH]);
  const out: Buffer[] = [];
  const CHUNK = 65500;
  for (let i = 0; i < stream.length; i += CHUNK) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), stream.subarray(i, Math.min(stream.length, i + CHUNK))])));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

export { buildTree, fileMapOf, storeObject };
export type { Repo };
