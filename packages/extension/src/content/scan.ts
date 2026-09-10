import { findTokens, MARKER } from "@entziffer/core";

/**
 * Anything matching this is treated as user-editable: the pane offers to edit it, and writing into
 * it is the one thing that can persist text back to the host application. See docs/threat-model.md.
 */
export const EDITABLE_SELECTOR =
  '[contenteditable]:not([contenteditable="false"]), .ProseMirror, [role="textbox"], input, textarea';

/** The extension's own shadow hosts; scanning and mutation handling must ignore them. */
export const OWN_SELECTOR = "[data-entz-host]";

/** Elements whose text is code or metadata rather than prose, and must never be rewritten. */
export const OPAQUE_SELECTOR = "script, style, noscript, template, title, svg";

const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "BODY",
  "DD",
  "DETAILS",
  "DIALOG",
  "DIV",
  "DL",
  "DT",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TBODY",
  "TD",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

export interface TokenLocation {
  token: string;
  editable: boolean;
  startNode: Text;
  startOffset: number;
  endNode: Text;
  endOffset: number;
}

export function rangeOf(loc: TokenLocation): Range {
  const doc = loc.startNode.ownerDocument as Document;
  const range = doc.createRange();
  range.setStart(loc.startNode, loc.startOffset);
  range.setEnd(loc.endNode, loc.endOffset);
  return range;
}

export function isAttached(loc: TokenLocation): boolean {
  return loc.startNode.isConnected && loc.endNode.isConnected;
}

export function isEditable(node: Node): boolean {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return el?.closest(EDITABLE_SELECTOR) != null;
}

/**
 * True when any part of the token sits in an editor: a token can start in an inert text node and
 * cross into an inline `contenteditable`, so both endpoints and every text node between them
 * decide. See {@link EDITABLE_SELECTOR}.
 */
export function isRangeEditable(startNode: Text, endNode: Text): boolean {
  if (isEditable(startNode) || isEditable(endNode)) return true;
  const doc = startNode.ownerDocument;
  if (startNode === endNode || doc === null) return false;
  const range = doc.createRange();
  range.setStart(startNode, 0);
  range.setEnd(endNode, 0);
  const walker = doc.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  walker.currentNode = startNode;
  for (let n = walker.nextNode(); n !== null && n !== endNode; n = walker.nextNode()) {
    if (isEditable(n)) return true;
  }
  return false;
}

export function isOwnNode(node: Node): boolean {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return el?.closest(OWN_SELECTOR) != null;
}

function isOpaque(node: Node): boolean {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return el?.closest(OPAQUE_SELECTOR) != null;
}

function blockContainer(node: Node): Node {
  let el = node.parentElement;
  while (el !== null && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement;
  return el ?? node.ownerDocument ?? node;
}

interface TextRun {
  nodes: Text[];
  starts: number[];
  text: string;
}

/**
 * Groups text nodes that render as one line of text so a token split across inline elements
 * (`ENT<b>Z1:</b>abc`) is still found. Runs break at block-level boundaries.
 */
export function collectRuns(root: Node): TextRun[] {
  const runs: TextRun[] = [];
  let current: TextRun | null = null;
  let currentBlock: Node | null = null;

  const push = (node: Text): void => {
    const block = blockContainer(node);
    if (current === null || block !== currentBlock) {
      current = { nodes: [], starts: [], text: "" };
      currentBlock = block;
      runs.push(current);
    }
    current.starts.push(current.text.length);
    current.nodes.push(node);
    current.text += node.data;
  };

  if (root.nodeType === Node.TEXT_NODE) {
    if (!isOwnNode(root) && !isOpaque(root)) push(root as Text);
    return runs;
  }
  if (
    root.nodeType === Node.ELEMENT_NODE &&
    (root as Element).matches(`${OWN_SELECTOR}, ${OPAQUE_SELECTOR}`)
  ) {
    return runs;
  }

  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        return (node as Element).matches(`${OWN_SELECTOR}, ${OPAQUE_SELECTOR}`)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) push(n as Text);
  return runs;
}

function locate(run: TextRun, index: number): { node: Text; offset: number } {
  let i = run.starts.length - 1;
  while (i > 0 && (run.starts[i] as number) > index) i--;
  return { node: run.nodes[i] as Text, offset: index - (run.starts[i] as number) };
}

/** Finds every token under `root`, resolving each to a precise `[start, end)` text range. */
export function scan(root: Node): TokenLocation[] {
  const out: TokenLocation[] = [];
  for (const run of collectRuns(root)) {
    if (!run.text.includes(MARKER)) continue;
    for (const match of findTokens(run.text)) {
      const start = locate(run, match.start);
      const end = locate(run, match.end - 1);
      out.push({
        token: match.token,
        editable: isRangeEditable(start.node, end.node),
        startNode: start.node,
        startOffset: start.offset,
        endNode: end.node,
        endOffset: end.offset + 1,
      });
    }
  }
  return out;
}
