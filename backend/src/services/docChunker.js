const crypto = require('node:crypto');
const path = require('node:path');

// MiniLM's context window is 256 wordpiece tokens. Leave room for special
// tokens; ordinary chunks target ~220 and never exceed 240 model tokens.
const DEFAULT_MAX_TOKENS = 240;
const DEFAULT_TARGET_TOKENS = 220;

function approximateTokenCount(text) {
  const trimmed = String(text || '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function extractSections(markdown, source = 'document.md') {
  const sections = [];
  const headingStack = [];
  let currentLines = [];
  let currentTitle = '';
  let fenceMarker = null;
  let fenceLength = 0;

  function flush() {
    const body = currentLines.join('\n').trim();
    if (body) sections.push({ section: currentTitle || path.basename(source), body });
    currentLines = [];
  }

  for (const line of String(markdown || '').split(/\r?\n/)) {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1][0];
      if (!fenceMarker) {
        fenceMarker = marker;
        fenceLength = fence[1].length;
      } else if (fenceMarker === marker && fence[1].length >= fenceLength) {
        fenceMarker = null;
        fenceLength = 0;
      }
      currentLines.push(line);
      continue;
    }

    const heading = fenceMarker ? null : line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!heading) {
      currentLines.push(line);
      continue;
    }

    flush();
    const level = heading[1].length;
    headingStack.length = level - 1;
    headingStack[level - 1] = heading[2].trim();
    currentTitle = headingStack.filter(Boolean).join(' › ');
  }
  flush();

  if (!sections.length && String(markdown || '').trim()) {
    sections.push({ section: path.basename(source), body: String(markdown).trim() });
  }
  return sections;
}

function renderSections(sections) {
  return sections.map(({ section, body }) => `## ${section}\n\n${body}`).join('\n\n');
}

async function groupShortSections(sections, tokenCount, maxTokens, targetTokens) {
  const groups = [];
  let pending = [];

  async function flush() {
    if (pending.length) groups.push(pending);
    pending = [];
  }

  for (const section of sections) {
    const sectionTokens = await tokenCount(renderSections([section]));
    if (sectionTokens > maxTokens) {
      await flush();
      groups.push([section]);
      continue;
    }

    const candidate = [...pending, section];
    if (pending.length && await tokenCount(renderSections(candidate)) > maxTokens) {
      await flush();
    }
    pending.push(section);
    if (await tokenCount(renderSections(pending)) >= targetTokens) await flush();
  }
  await flush();
  return groups;
}

function splitLongBlockBySentences(block) {
  const lines = block.split('\n');
  const units = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Preserve list/table/code lines as structural units; split prose at
    // sentence boundaries before resorting to word boundaries.
    if (/^(?:[-*+]\s|\d+[.)]\s|\|)/.test(trimmed) || trimmed.startsWith('```')) {
      units.push(trimmed);
      continue;
    }
    const sentences = trimmed.match(/[^.!?]+(?:[.!?]+|$)/g) || [trimmed];
    units.push(...sentences.map((sentence) => sentence.trim()).filter(Boolean));
  }
  return units.length ? units : [block.trim()];
}

async function splitUnitToFit(unit, prefix, maxTokens, tokenCount) {
  const words = unit.split(/\s+/).filter(Boolean);
  const output = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && await tokenCount(`${prefix}${candidate}`) > maxTokens) {
      output.push(current);
      current = word;
    } else {
      current = candidate;
    }
    if (!current.includes(' ') && await tokenCount(`${prefix}${current}`) > maxTokens) {
      throw new Error('A single unbroken text token exceeds the embedding chunk limit');
    }
  }
  if (current) output.push(current);
  return output;
}

/**
 * Split Markdown by headings and paragraph boundaries, combining adjacent short
 * sections where useful. Oversized sections split at sentence boundaries and
 * only then at word boundaries, preserving their heading context.
 */
async function chunkMarkdownDocument({
  markdown,
  source = 'document.md',
  tokenCount = approximateTokenCount,
  maxTokens = DEFAULT_MAX_TOKENS,
  targetTokens = DEFAULT_TARGET_TOKENS,
}) {
  if (typeof tokenCount !== 'function') throw new TypeError('tokenCount must be a function');
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new RangeError('maxTokens must be a positive integer');
  if (!Number.isSafeInteger(targetTokens) || targetTokens < 1) throw new RangeError('targetTokens must be a positive integer');
  const target = Math.min(targetTokens, maxTokens);
  const chunks = [];
  const sections = extractSections(markdown, source);
  const sectionGroups = await groupShortSections(sections, tokenCount, maxTokens, target);

  async function emit({ section, text }) {
    const measuredTokens = await tokenCount(text);
    if (measuredTokens > maxTokens) throw new Error(`Chunk in ${source} exceeded ${maxTokens} model tokens`);
    const chunkIndex = chunks.length + 1;
    const id = crypto.createHash('sha256')
      .update(`${source}\0${section}\0${chunkIndex}\0${text}`)
      .digest('hex')
      .slice(0, 24);
    chunks.push({ id, source, section, text, token_count: measuredTokens });
  }

  for (const group of sectionGroups) {
    const groupText = renderSections(group);
    const groupTokens = await tokenCount(groupText);
    if (groupTokens <= maxTokens) {
      await emit({
        section: group.map((item) => item.section).join(' | '),
        text: groupText,
      });
      continue;
    }

    // A single section can exceed the model window. Accumulate its paragraphs
    // until the next one would cross the ceiling.
    const [section] = group;
    const headingContext = `## ${section.section}\n\n`;
    const paragraphs = section.body.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
    let pending = [];

    async function emitPending() {
      if (!pending.length) return;
      await emit({ section: section.section, text: `${headingContext}${pending.join('\n\n')}`.trim() });
      pending = [];
    }

    for (const paragraph of paragraphs) {
      const candidate = `${headingContext}${[...pending, paragraph].join('\n\n')}`.trim();
      if (pending.length && await tokenCount(candidate) > maxTokens) await emitPending();

      if (await tokenCount(`${headingContext}${paragraph}`.trim()) <= maxTokens) {
        pending.push(paragraph);
        if (await tokenCount(`${headingContext}${pending.join('\n\n')}`.trim()) >= target) await emitPending();
        continue;
      }

      await emitPending();
      for (const unit of splitLongBlockBySentences(paragraph)) {
        const unitText = `${headingContext}${unit}`.trim();
        if (await tokenCount(unitText) <= maxTokens) {
          const candidateText = `${headingContext}${[...pending, unit].join('\n\n')}`.trim();
          if (pending.length && await tokenCount(candidateText) > maxTokens) await emitPending();
          pending.push(unit);
          if (await tokenCount(`${headingContext}${pending.join('\n\n')}`.trim()) >= target) await emitPending();
          continue;
        }

        await emitPending();
        const pieces = await splitUnitToFit(unit, headingContext, maxTokens, tokenCount);
        for (const piece of pieces) {
          const candidateText = `${headingContext}${[...pending, piece].join('\n\n')}`.trim();
          if (pending.length && await tokenCount(candidateText) > maxTokens) await emitPending();
          pending.push(piece);
          if (await tokenCount(`${headingContext}${pending.join('\n\n')}`.trim()) >= target) await emitPending();
        }
      }
    }
    await emitPending();
  }

  return chunks;
}

module.exports = {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TARGET_TOKENS,
  approximateTokenCount,
  extractSections,
  chunkMarkdownDocument,
};
