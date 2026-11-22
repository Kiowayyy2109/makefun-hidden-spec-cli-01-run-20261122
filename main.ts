// mend: one patch tool for every AI edit format.
//
// A patch arrives in one of four shapes -- a unified diff, SEARCH/REPLACE
// blocks, a V4A patch, or JSON text-editor calls -- and names lines to
// replace in a tree of text files. This file reads the patch, finds those
// lines at the first of three matching tiers, and writes every change or
// none at all. Node 22, standard library only, nothing random, nothing
// clocked: the same patch on the same tree always gives the same answer.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runTrial } from './runner.ts';

// ---------- small text helpers ----------

/** True when a line holds nothing but whitespace. */
function isBlankLine(line: string): boolean {
  return line.trim() === '';
}

/** A line with its trailing spaces, tabs and carriage returns cut off. */
function stripTrailingWs(line: string): string {
  return line.replace(/[ \t\r]+$/, '');
}

/** A line with its leading and trailing spaces and tabs cut off. */
function stripEdgeWs(line: string): string {
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** The spaces and tabs at the start of a line. */
function leadingWsOf(line: string): string {
  const found = /^[ \t]*/.exec(line);
  return found === null ? '' : found[0];
}

/** Byte order (UTF-8) for sorting paths in the final report. */
function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * The lines of a patch: split at \n, one trailing \r off each line, and no
 * empty piece after a final \n.
 */
function splitPatchLines(text: string): string[] {
  const pieces = text.split('\n');
  if (pieces.length > 0 && pieces[pieces.length - 1] === '') pieces.pop();
  return pieces.map((piece) => (piece.endsWith('\r') ? piece.slice(0, -1) : piece));
}

interface FileView {
  brk: '\r\n' | '\n';
  lines: string[];
  ends: boolean;
}

/**
 * How a file's bytes read as lines: its break is CRLF when its first line
 * feed follows a carriage return, LF otherwise. An empty file has no lines
 * and no final break; a file of no lines is written empty.
 */
function viewOf(text: string): FileView {
  if (text === '') return { brk: '\n', lines: [], ends: false };
  const at = text.indexOf('\n');
  const brk: '\r\n' | '\n' = at > 0 && text[at - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(brk);
  let ends = false;
  if (text.endsWith(brk)) {
    parts.pop();
    ends = true;
  }
  return { brk, lines: parts, ends };
}

/** The bytes of a file view: its own break between lines, and a final one exactly when it ends with one. */
function renderOf(view: FileView): string {
  if (view.lines.length === 0) return '';
  return view.lines.join(view.brk) + (view.ends ? view.brk : '');
}

// ---------- the working tree ----------

/**
 * The tree as the patch leaves it, held in memory until the whole patch is
 * known good. Nothing touches the disk before then, so a failed patch
 * writes nothing at all.
 */
class Tree {
  private current = new Map<string, string | null>();
  private before = new Map<string, string | null>();

  private loadDisk(path: string): string | null {
    try {
      if (!statSync(path).isFile()) return null;
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  }

  private touch(path: string): void {
    if (!this.current.has(path)) {
      const onDisk = this.loadDisk(path);
      this.current.set(path, onDisk);
      this.before.set(path, onDisk);
    }
  }

  read(path: string): string | null {
    this.touch(path);
    const value = this.current.get(path);
    return value === undefined ? null : value;
  }

  has(path: string): boolean {
    return this.read(path) !== null;
  }

  write(path: string, text: string): void {
    this.touch(path);
    this.current.set(path, text);
  }

  remove(path: string): void {
    this.touch(path);
    this.current.set(path, null);
  }

  /** Change lines for the report: A, D and M per path, moves folded into R lines sorted by their new path. */
  changeLines(moves: { from: string; to: string }[]): { sort: string; text: string }[] {
    const out: { sort: string; text: string }[] = [];
    for (const [path, after] of this.current) {
      const was = this.before.get(path) ?? null;
      if (was === null && after !== null) out.push({ sort: path, text: `A ${path}` });
      else if (was !== null && after === null) out.push({ sort: path, text: `D ${path}` });
      else if (was !== null && after !== null && was !== after) out.push({ sort: path, text: `M ${path}` });
    }
    for (const move of moves) {
      const wasOld = this.before.get(move.from) ?? null;
      const isOld = this.current.get(move.from) ?? null;
      const wasNew = this.before.get(move.to) ?? null;
      const isNew = this.current.get(move.to) ?? null;
      if (wasOld !== null && isOld === null && wasNew === null && isNew !== null) {
        const dropD = out.findIndex((c) => c.sort === move.from && c.text.startsWith('D '));
        if (dropD !== -1) out.splice(dropD, 1);
        const dropA = out.findIndex((c) => c.sort === move.to && c.text.startsWith('A '));
        if (dropA !== -1) out.splice(dropA, 1);
        out.push({ sort: move.to, text: `R ${move.from} -> ${move.to}` });
      }
    }
    out.sort((a, b) => compareBytes(a.sort, b.sort));
    return out;
  }

  /** Write every change to disk, creating directories as files need them. */
  flush(): void {
    for (const [path, after] of this.current) {
      const was = this.before.get(path) ?? null;
      if (after === was) continue;
      if (after === null) {
        rmSync(path, { force: true });
      } else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, after, 'utf8');
      }
    }
  }
}

// ---------- matching lines ----------

/** One line as a tier reads it: exact, trailing whitespace off, or both edges off. */
function keyAt(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return stripEdgeWs(line);
}

/** Every 0-based position where the old lines occur in the file's lines at one tier, overlaps allowed. */
function spotsAt(fileLines: string[], oldLines: string[], tier: number, from: number): number[] {
  const spots: number[] = [];
  const count = oldLines.length;
  if (count === 0) return spots;
  const wanted = oldLines.map((line) => keyAt(line, tier));
  const start = from < 0 ? 0 : from;
  for (let i = start; i + count <= fileLines.length; i++) {
    let hit = true;
    for (let j = 0; j < count; j++) {
      if (keyAt(fileLines[i + j], tier) !== wanted[j]) {
        hit = false;
        break;
      }
    }
    if (hit) spots.push(i);
  }
  return spots;
}

/** The first tier at which the old lines occur at least once, with every occurrence there. */
function firstTier(fileLines: string[], oldLines: string[], from: number, strict: boolean): { tier: number; spots: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const spots = spotsAt(fileLines, oldLines, tier, from);
    if (spots.length > 0) return { tier, spots };
  }
  return null;
}

/**
 * One line of the replacement: ctx >= 0 copies the file's own matched line
 * at match + ctx (a context line), ctx -1 is a fresh line from the patch.
 */
interface NewPiece {
  text: string;
  ctx: number;
}

/**
 * The lines that replace a match. Context lines come from the file itself.
 * At tier 2 every other line is re-indented: the leading spaces and tabs of
 * the patch's first old line are swapped for those of the file's first
 * matched line, on lines that are not blank and start with them.
 */
function buildNewLines(fileLines: string[], at: number, oldLines: string[], pieces: NewPiece[], tier: number): string[] {
  const fileLead = leadingWsOf(fileLines[at] ?? '');
  const patchLead = leadingWsOf(oldLines[0] ?? '');
  const out: string[] = [];
  for (const piece of pieces) {
    if (piece.ctx >= 0) {
      out.push(fileLines[at + piece.ctx]);
      continue;
    }
    if (tier !== 2) {
      out.push(piece.text);
      continue;
    }
    if (piece.text === '' || /^[ \t]+$/.test(piece.text)) {
      out.push(piece.text);
      continue;
    }
    if (piece.text.startsWith(patchLead)) out.push(fileLead + piece.text.slice(patchLead.length));
    else out.push(piece.text);
  }
  return out;
}

// ---------- edits, paths and parse faults ----------

type Outcome =
  | { ok: true; move?: { from: string; to: string } }
  | { ok: false; code: string; path: string };

interface Edit {
  apply(tree: Tree, strict: boolean): Outcome;
}

/** A path is safe when it is not empty, does not start with /, holds no \, and no segment is empty, . or ... */
function safePath(path: string): boolean {
  if (path === '') return false;
  if (path.startsWith('/')) return false;
  if (path.includes('\\')) return false;
  for (const piece of path.split('/')) {
    if (piece === '' || piece === '.' || piece === '..') return false;
  }
  return true;
}

function badPath(path: string): Outcome {
  return { ok: false, code: 'unsafe', path };
}

class ParseFault extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

// ---------- hunk and chunk bodies ----------

type BodyKind = 'ctx' | 'old' | 'add' | 'back';

interface BodyLine {
  kind: BodyKind;
  text: string;
}

/** One body line read by its marker: space or empty is context, - old, + new, \ a newline note. */
function bodyLineOf(line: string): BodyLine {
  if (line === '') return { kind: 'ctx', text: '' };
  const mark = line[0];
  if (mark === ' ') return { kind: 'ctx', text: line.slice(1) };
  if (mark === '-') return { kind: 'old', text: line.slice(1) };
  if (mark === '+') return { kind: 'add', text: line.slice(1) };
  return { kind: 'back', text: line };
}

/** A body's old lines O and its new lines N, with context lines tied to their place in O. */
function splitOldNew(body: BodyLine[]): { oldLines: string[]; pieces: NewPiece[] } {
  const oldLines: string[] = [];
  const pieces: NewPiece[] = [];
  for (const line of body) {
    if (line.kind === 'ctx') {
      oldLines.push(line.text);
      pieces.push({ text: line.text, ctx: oldLines.length - 1 });
    } else if (line.kind === 'old') {
      oldLines.push(line.text);
    } else if (line.kind === 'add') {
      pieces.push({ text: line.text, ctx: -1 });
    }
  }
  return { oldLines, pieces };
}

/**
 * Whether a hunk's result ends with a line break: it does, unless a \ line
 * follows the hunk's last context or + line.
 */
function hunkEndsBroken(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i].kind === 'ctx' || body[i].kind === 'add') last = i;
  }
  if (last === -1) return true;
  if (last + 1 < body.length && body[last + 1].kind === 'back') return false;
  return true;
}

// ---------- unified diffs ----------

interface Hunk {
  oldStart: number;
  body: BodyLine[];
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  startedByDiff: boolean;
  hunks: Hunk[];
}

/** The path of a --- or +++ line: after the four characters, up to the first tab, spaces off. */
function headerPathOf(line: string): string {
  let rest = line.slice(4);
  const tabAt = rest.indexOf('\t');
  if (tabAt >= 0) rest = rest.slice(0, tabAt);
  return rest.trim();
}

/** One leading a/ or b/ off a header path. */
function stripPrefix(path: string): string {
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  return path;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const DIFF_GIT = /^diff --git a\/([^ ]+) b\/([^ ]+)$/;

function parseUnified(lines: string[]): Edit[] {
  const sections: Section[] = [];
  const openSection = (): Section => {
    const s: Section = {
      diffOld: null,
      diffNew: null,
      oldPath: null,
      newPath: null,
      hasPair: false,
      renameFrom: null,
      renameTo: null,
      newFile: false,
      deletedFile: false,
      startedByDiff: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  let current: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const found = DIFF_GIT.exec(line);
      if (found === null) throw new ParseFault(i + 1);
      current = openSection();
      current.startedByDiff = true;
      current.diffOld = found[1];
      current.diffNew = found[2];
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      if (current !== null && current.hunks.length === 0 && !current.hasPair && current.startedByDiff) {
        current.oldPath = headerPathOf(line);
        current.newPath = headerPathOf(lines[i + 1]);
        current.hasPair = true;
      } else {
        current = openSection();
        current.oldPath = headerPathOf(line);
        current.newPath = headerPathOf(lines[i + 1]);
        current.hasPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const found = HUNK_HEAD.exec(line);
      if (found === null) throw new ParseFault(i + 1);
      if (current === null) throw new ParseFault(i + 1);
      const oldStart = Number.parseInt(found[1], 10);
      i += 1;
      const raw: string[] = [];
      while (i < lines.length) {
        const next = lines[i];
        if (next.startsWith('diff --git ')) break;
        if (next.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) break;
        if (next === '' || next[0] === ' ' || next[0] === '-' || next[0] === '+' || next[0] === '\\') {
          raw.push(next);
          i += 1;
        } else break;
      }
      while (raw.length > 0 && (raw[raw.length - 1] === '' || raw[raw.length - 1] === ' ')) raw.pop();
      current.hunks.push({ oldStart, body: raw.map(bodyLineOf) });
      continue;
    }
    if (current !== null && current.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new ParseFault(i + 2);
      if (line.startsWith('rename from ')) {
        if (current.renameFrom === null) current.renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (current.renameTo === null) current.renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        current.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        current.deletedFile = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new ParseFault(1);
  return sections.map(unifiedEdit);
}

/**
 * One section's hunks on a file's lines, in order. d is the drift so far:
 * the sum of each hunk's new length minus its old length. A hunk whose old
 * lines are empty inserts after the first A + d lines; any other takes the
 * occurrence nearest to A - 1 + d, the earlier of two equally near.
 */
function runHunks(view: FileView, hunks: Hunk[], strict: boolean): { lines: string[]; ends: boolean } | null {
  let lines = [...view.lines];
  let ends = view.ends;
  let drift = 0;
  for (const hunk of hunks) {
    const { oldLines, pieces } = splitOldNew(hunk.body);
    if (oldLines.length === 0) {
      const before = lines.length;
      const at = Math.min(Math.max(hunk.oldStart + drift, 0), before);
      const fresh = pieces.map((piece) => piece.text);
      lines.splice(at, 0, ...fresh);
      if (at === before) ends = hunkEndsBroken(hunk.body);
      drift += pieces.length;
      continue;
    }
    const found = firstTier(lines, oldLines, 0, strict);
    if (found === null) return null;
    const want = hunk.oldStart - 1 + drift;
    let best = found.spots[0];
    let bestGap = Math.abs(best - want);
    for (const spot of found.spots) {
      const gap = Math.abs(spot - want);
      if (gap < bestGap) {
        best = spot;
        bestGap = gap;
      }
    }
    const touchesEnd = best + oldLines.length === lines.length;
    const made = buildNewLines(lines, best, oldLines, pieces, found.tier);
    lines.splice(best, oldLines.length, ...made);
    if (touchesEnd) ends = hunkEndsBroken(hunk.body);
    drift += pieces.length - oldLines.length;
  }
  return { lines, ends };
}

function unifiedEdit(section: Section): Edit {
  let oldP: string | null = null;
  let newP: string | null = null;
  if (section.hasPair) {
    oldP = stripPrefix(section.oldPath ?? '');
    newP = stripPrefix(section.newPath ?? '');
  } else if (section.renameFrom !== null || section.renameTo !== null) {
    oldP = section.renameFrom;
    newP = section.renameTo;
  } else {
    oldP = section.diffOld;
    newP = section.diffNew;
  }
  if (oldP === null) oldP = newP;
  if (newP === null) newP = oldP;
  if (oldP === null || newP === null) throw new ParseFault(1);
  const oldPath = oldP;
  const newPath = newP;
  const isCreate = oldPath === '/dev/null' || section.newFile;
  const isDelete = !isCreate && (newPath === '/dev/null' || section.deletedFile);
  const isMove = !isCreate && !isDelete && oldPath !== newPath;
  return {
    apply(tree, strict) {
      if (oldPath !== '/dev/null' && !safePath(oldPath)) return badPath(oldPath);
      if (newPath !== '/dev/null' && !safePath(newPath)) return badPath(newPath);
      if (isCreate) {
        if (tree.has(newPath)) return { ok: false, code: 'exists', path: newPath };
        const made: string[] = [];
        for (const hunk of section.hunks) {
          for (const line of hunk.body) if (line.kind === 'add') made.push(line.text);
        }
        let ends = true;
        for (let h = section.hunks.length - 1; h >= 0; h--) {
          const body = section.hunks[h].body;
          let sawAdd = false;
          for (let k = body.length - 1; k >= 0; k--) {
            if (body[k].kind === 'add') {
              ends = !(k + 1 < body.length && body[k + 1].kind === 'back');
              sawAdd = true;
              break;
            }
          }
          if (sawAdd) break;
        }
        tree.write(newPath, renderOf({ brk: '\n', lines: made, ends }));
        return { ok: true };
      }
      if (isDelete) {
        if (!tree.has(oldPath)) return { ok: false, code: 'missing', path: oldPath };
        tree.remove(oldPath);
        return { ok: true };
      }
      const current = tree.read(oldPath);
      if (current === null) return { ok: false, code: 'missing', path: oldPath };
      if (isMove && tree.has(newPath)) return { ok: false, code: 'exists', path: newPath };
      const view = viewOf(current);
      const done = runHunks(view, section.hunks, strict);
      if (done === null) return { ok: false, code: 'no-match', path: oldPath };
      const text = renderOf({ brk: view.brk, lines: done.lines, ends: done.ends });
      if (isMove) {
        tree.write(newPath, text);
        tree.remove(oldPath);
        return { ok: true, move: { from: oldPath, to: newPath } };
      }
      tree.write(oldPath, text);
      return { ok: true };
    },
  };
}

// ---------- SEARCH/REPLACE blocks ----------

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let afterPrev = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (stripTrailingWs(lines[i]) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchNo = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= afterPrev; j--) {
      const trimmed = lines[j].trim();
      if (trimmed === '') continue;
      if (trimmed.startsWith('```')) continue;
      path = trimmed;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new ParseFault(searchNo);
    }
    let k = i + 1;
    while (k < lines.length && stripTrailingWs(lines[k]) !== '=======') k += 1;
    if (k >= lines.length) throw new ParseFault(searchNo);
    let m = k + 1;
    while (m < lines.length && stripTrailingWs(lines[m]) !== '>>>>>>> REPLACE') m += 1;
    if (m >= lines.length) throw new ParseFault(searchNo);
    const oldLines = lines.slice(i + 1, k);
    const newLines = lines.slice(k + 1, m);
    edits.push(searchReplaceEdit(path, oldLines, newLines));
    prevPath = path;
    afterPrev = m + 1;
    i = m + 1;
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return {
    apply(tree, strict) {
      if (!safePath(path)) return badPath(path);
      if (oldLines.length === 0) {
        if (tree.has(path)) return { ok: false, code: 'exists', path };
        tree.write(path, renderOf({ brk: '\n', lines: [...newLines], ends: true }));
        return { ok: true };
      }
      const current = tree.read(path);
      if (current === null) return { ok: false, code: 'missing', path };
      const view = viewOf(current);
      const found = firstTier(view.lines, oldLines, 0, strict);
      if (found === null) return { ok: false, code: 'no-match', path };
      if (found.spots.length > 1) return { ok: false, code: 'ambiguous', path };
      const at = found.spots[0];
      const pieces: NewPiece[] = newLines.map((text) => ({ text, ctx: -1 }));
      const made = buildNewLines(view.lines, at, oldLines, pieces, found.tier);
      const lines = [...view.lines];
      lines.splice(at, oldLines.length, ...made);
      tree.write(path, renderOf({ brk: view.brk, lines, ends: view.ends }));
      return { ok: true };
    },
  };
}

// ---------- V4A patches ----------

const SECTION_START = /^\*\*\* (Add File|Delete File|Update File):(.*)$/;

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function parseV4a(lines: string[]): Edit[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlankLine(lines[i])) {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) throw new ParseFault(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  if (lines[last].trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i += 1;
      continue;
    }
    const found = SECTION_START.exec(line);
    if (found === null) throw new ParseFault(i + 1);
    const kind = found[1];
    const path = found[2].trim();
    let j = i + 1;
    while (j < last && SECTION_START.exec(lines[j]) === null) j += 1;
    const raw: { text: string; no: number }[] = [];
    for (let k = i + 1; k < j; k++) raw.push({ text: lines[k], no: k + 1 });
    while (raw.length > 0 && isBlankLine(raw[raw.length - 1].text)) raw.pop();
    edits.push(v4aEdit(kind, path, raw, i + 1));
    i = j;
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

function v4aEdit(kind: string, path: string, raw: { text: string; no: number }[], sectionNo: number): Edit {
  if (kind === 'Add File') {
    const made: string[] = [];
    for (const item of raw) {
      if (item.text.startsWith('+')) made.push(item.text.slice(1));
      else if (item.text === '') made.push('');
      else throw new ParseFault(item.no);
    }
    return {
      apply(tree) {
        if (!safePath(path)) return badPath(path);
        if (tree.has(path)) return { ok: false, code: 'exists', path };
        tree.write(path, renderOf({ brk: '\n', lines: made, ends: true }));
        return { ok: true };
      },
    };
  }
  if (kind === 'Delete File') {
    for (const item of raw) {
      if (!isBlankLine(item.text)) throw new ParseFault(item.no);
    }
    return {
      apply(tree) {
        if (!safePath(path)) return badPath(path);
        if (!tree.has(path)) return { ok: false, code: 'missing', path };
        tree.remove(path);
        return { ok: true };
      },
    };
  }
  let moveTo: string | null = null;
  let at = 0;
  if (raw.length > 0 && raw[0].text.startsWith('*** Move to:')) {
    moveTo = raw[0].text.slice('*** Move to:'.length).trim();
    at = 1;
  }
  const chunks: V4aChunk[] = [];
  let open: V4aChunk | null = null;
  for (; at < raw.length; at++) {
    const item = raw[at];
    const text = item.text;
    if (text.startsWith('@@')) {
      open = { anchor: text.slice(2).trim(), eof: false, body: [] };
      chunks.push(open);
      continue;
    }
    if (text === '*** End of File') {
      if (open !== null) {
        open.eof = true;
        open = null;
      }
      continue;
    }
    if (text.startsWith('*** Move to:')) throw new ParseFault(item.no);
    if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
      if (open === null) {
        if (chunks.length > 0) throw new ParseFault(item.no);
        open = { anchor: null, eof: false, body: [] };
        chunks.push(open);
      }
      open.body.push(bodyLineOf(text));
      continue;
    }
    throw new ParseFault(item.no);
  }
  if (chunks.length === 0 && moveTo === null) throw new ParseFault(sectionNo);
  const target = moveTo;
  return {
    apply(tree, strict) {
      if (!safePath(path)) return badPath(path);
      if (target !== null && !safePath(target)) return badPath(target);
      const current = tree.read(path);
      if (current === null) return { ok: false, code: 'missing', path };
      if (target !== null && tree.has(target)) return { ok: false, code: 'exists', path: target };
      const view = viewOf(current);
      let lines = [...view.lines];
      let cursor = 0;
      for (const chunk of chunks) {
        if (chunk.anchor !== null && chunk.anchor !== '') {
          let placed = -1;
          const tiers = strict ? [0] : [0, 1, 2];
          for (const tier of tiers) {
            for (let p = cursor; p < lines.length; p++) {
              if (keyAt(lines[p], tier) === keyAt(chunk.anchor, tier)) {
                placed = p;
                break;
              }
            }
            if (placed !== -1) break;
          }
          if (placed === -1) return { ok: false, code: 'no-match', path };
          cursor = placed + 1;
        }
        const { oldLines, pieces } = splitOldNew(chunk.body);
        if (oldLines.length === 0) {
          const at = chunk.eof ? lines.length : cursor;
          const fresh = pieces.map((piece) => piece.text);
          lines.splice(at, 0, ...fresh);
          cursor = at + fresh.length;
          continue;
        }
        let hit: { tier: number; pos: number } | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const tier of tiers) {
          const spots = spotsAt(lines, oldLines, tier, cursor).filter(
            (spot) => !chunk.eof || spot + oldLines.length === lines.length,
          );
          if (spots.length > 0) {
            hit = { tier, pos: spots[0] };
            break;
          }
        }
        if (hit === null) return { ok: false, code: 'no-match', path };
        const made = buildNewLines(lines, hit.pos, oldLines, pieces, hit.tier);
        lines.splice(hit.pos, oldLines.length, ...made);
        cursor = hit.pos + made.length;
      }
      const text = renderOf({ brk: view.brk, lines, ends: view.ends });
      if (target !== null) {
        tree.write(target, text);
        tree.remove(path);
        return { ok: true, move: { from: path, to: target } };
      }
      tree.write(path, text);
      return { ok: true };
    },
  };
}

// ---------- JSON edits ----------

function parseJson(lines: string[], patchText: string): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlankLine(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseFault(1);
  const edits: Edit[] = [];
  const firstChar = lines[first].trimStart()[0];
  if (firstChar === '[') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(patchText);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(parsed)) throw new ParseFault(first + 1);
    for (const item of parsed) edits.push(jsonEdit(item, first + 1));
  } else {
    for (let i = 0; i < lines.length; i++) {
      if (isBlankLine(lines[i])) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(lines[i]);
      } catch {
        throw new ParseFault(i + 1);
      }
      edits.push(jsonEdit(obj, i + 1));
    }
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

function jsonEdit(value: unknown, lineNo: number): Edit {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ParseFault(lineNo);
  const obj = value as Record<string, unknown>;
  if (typeof obj.command !== 'string') throw new ParseFault(lineNo);
  if (typeof obj.path !== 'string') throw new ParseFault(lineNo);
  const path = obj.path;
  if (obj.command === 'create') {
    if (typeof obj.file_text !== 'string') throw new ParseFault(lineNo);
    const text = obj.file_text;
    return {
      apply(tree) {
        if (!safePath(path)) return badPath(path);
        if (tree.has(path)) return { ok: false, code: 'exists', path };
        tree.write(path, text);
        return { ok: true };
      },
    };
  }
  if (obj.command === 'str_replace') {
    if (typeof obj.old_str !== 'string' || obj.old_str === '') throw new ParseFault(lineNo);
    if (obj.new_str !== undefined && typeof obj.new_str !== 'string') throw new ParseFault(lineNo);
    const oldStr = obj.old_str;
    const newStr = (obj.new_str as string | undefined) ?? '';
    return {
      apply(tree) {
        if (!safePath(path)) return badPath(path);
        const current = tree.read(path);
        if (current === null) return { ok: false, code: 'missing', path };
        const crlf = viewOf(current).brk === '\r\n';
        let text = current;
        let oldS = oldStr;
        let newS = newStr;
        if (crlf) {
          text = current.replace(/\r\n/g, '\n');
          oldS = oldStr.replace(/\r\n/g, '\n');
          newS = newStr.replace(/\r\n/g, '\n');
        }
        let count = 0;
        let firstAt = -1;
        let scan = 0;
        for (;;) {
          const at = text.indexOf(oldS, scan);
          if (at === -1) break;
          if (firstAt === -1) firstAt = at;
          count += 1;
          if (count > 1) break;
          scan = at + 1;
        }
        if (count === 0) return { ok: false, code: 'no-match', path };
        if (count > 1) return { ok: false, code: 'ambiguous', path };
        const made = text.slice(0, firstAt) + newS + text.slice(firstAt + oldS.length);
        tree.write(path, crlf ? made.replace(/\n/g, '\r\n') : made);
        return { ok: true };
      },
    };
  }
  if (obj.command === 'insert') {
    if (typeof obj.insert_line !== 'number' || !Number.isInteger(obj.insert_line)) throw new ParseFault(lineNo);
    if (typeof obj.new_str !== 'string') throw new ParseFault(lineNo);
    const atLine = obj.insert_line;
    const newStr = obj.new_str;
    return {
      apply(tree) {
        if (!safePath(path)) return badPath(path);
        const current = tree.read(path);
        if (current === null) return { ok: false, code: 'missing', path };
        const view = viewOf(current);
        if (atLine < 0 || atLine > view.lines.length) return { ok: false, code: 'no-match', path };
        const fresh = splitPatchLines(newStr);
        const lines = [...view.lines];
        lines.splice(atLine, 0, ...fresh);
        tree.write(path, renderOf({ brk: view.brk, lines, ends: view.ends }));
        return { ok: true };
      },
    };
  }
  throw new ParseFault(lineNo);
}

// ---------- detecting the format ----------

/**
 * With --format=auto the format is the first of these that holds: a first
 * non-blank line of *** Begin Patch is v4a; a first non-whitespace character
 * of [ or { is json; a line of <<<<<<< SEARCH is search-replace; a
 * diff --git line, or a --- line followed by a +++ line, is unified.
 */
function detectFormat(lines: string[]): 'unified' | 'search-replace' | 'v4a' | 'json' | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlankLine(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const firstChar = lines[first].trimStart()[0];
  if (firstChar === '[' || firstChar === '{') return 'json';
  for (let i = 0; i < lines.length; i++) {
    if (stripTrailingWs(lines[i]) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------- the command line ----------

interface Options {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

/**
 * Reads the arguments: --format=NAME, --check, --strict, and one PATCH, in
 * any order, with -- ending the options. Returns null on a usage error: an
 * unknown dash argument, an option twice, a bad --format value, or more than
 * one positional argument.
 */
function parseArgs(argv: string[]): Options | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  const positionals: string[] = [];
  let noMoreOptions = false;
  for (const arg of argv) {
    if (!noMoreOptions && arg === '--') {
      noMoreOptions = true;
      continue;
    }
    if (!noMoreOptions && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check') {
        if (seenCheck) return null;
        seenCheck = true;
        check = true;
        continue;
      }
      if (arg === '--strict') {
        if (seenStrict) return null;
        seenStrict = true;
        strict = true;
        continue;
      }
      if (arg.startsWith('--format=')) {
        if (seenFormat) return null;
        seenFormat = true;
        const value = arg.slice('--format='.length);
        if (value !== 'unified' && value !== 'search-replace' && value !== 'v4a' && value !== 'json' && value !== 'auto') return null;
        format = value;
        continue;
      }
      return null;
    }
    positionals.push(arg);
  }
  if (positionals.length > 1) return null;
  return { format: format ?? 'auto', check, strict, patch: positionals.length === 1 ? positionals[0] : null };
}

// ---------- the run ----------

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (opts === null) {
    process.stdout.write('error: usage\n');
    process.exitCode = 2;
    return;
  }
  let patchText: string;
  if (opts.patch === null || opts.patch === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(opts.patch, 'utf8');
    } catch {
      process.stdout.write('error: no-patch\n');
      process.exitCode = 2;
      return;
    }
  }
  const lines = splitPatchLines(patchText);
  let format = opts.format;
  if (format === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) {
      process.stdout.write('error: format\n');
      process.exitCode = 2;
      return;
    }
    format = detected;
  }
  let edits: Edit[];
  try {
    if (format === 'unified') edits = parseUnified(lines);
    else if (format === 'search-replace') edits = parseSearchReplace(lines);
    else if (format === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(lines, patchText);
  } catch (err) {
    if (err instanceof ParseFault) {
      process.stdout.write(`error: parse ${err.line}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
  const tree = new Tree();
  const failures: { code: string; path: string }[] = [];
  const moves: { from: string; to: string }[] = [];
  for (const edit of edits) {
    const result = edit.apply(tree, opts.strict);
    if (!result.ok) failures.push({ code: result.code, path: result.path });
    else if (result.move !== undefined) moves.push(result.move);
  }
  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}`).join('\n') + `\nfailed: ${failures.length} of ${edits.length} edits\n`;
    process.stdout.write(out);
    process.exitCode = 1;
    return;
  }
  const changed = tree.changeLines(moves);
  if (!opts.check) tree.flush();
  const linesOut = changed.map((c) => c.text).join('\n');
  process.stdout.write((linesOut === '' ? '' : linesOut + '\n') + `ok: ${changed.length} file${changed.length === 1 ? '' : 's'}\n`);
  process.exitCode = 0;
}

// When the trial environment is set, hand the trial over to the runner
// instead of running the command line.
if (process.env.MAKEFUN_ENV_URL) {
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  main();
}
