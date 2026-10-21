const COMMAND_TEXT = Object.freeze({
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', ne: '≠', neq: '≠',
  le: '≤', leq: '≤', leqslant: '≤', ge: '≥', geq: '≥', geqslant: '≥',
  equiv: '≡', approx: '≈', sim: '∼', cong: '≅', propto: '∝', infty: '∞',
  in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩',
  emptyset: '∅', varnothing: '∅', parallel: '∥', perp: '⊥', angle: '∠', triangle: '△',
  to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', iff: '⇔',
  sum: '∑', prod: '∏', int: '∫', partial: '∂', nabla: '∇', forall: '∀', exists: '∃',
  because: '∵', therefore: '∴',
  cdots: '⋯', ldots: '…', dots: '…',
  pi: 'π', theta: 'θ', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', lambda: 'λ', mu: 'μ',
  omega: 'ω', phi: 'φ', varphi: 'φ', rho: 'ρ', sigma: 'σ',
  sin: 'sin', cos: 'cos', tan: 'tan', cot: 'cot', log: 'log', ln: 'ln', circ: '°', degree: '°',
  lim: 'lim', max: 'max', min: 'min', left: '', right: '', quad: ' ', qquad: ' ', text: ''
});

const SUPERSCRIPT = Object.freeze({
  0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ'
});

const SUBSCRIPT = Object.freeze({
  0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎'
});

const readCommand = (source, start) => {
  let end = start + 1;
  while (/[A-Za-z]/.test(source[end] || '')) end += 1;
  if (end === start + 1 && source[end]) end += 1;
  return { value: source.slice(start + 1, end), end };
};

const readBalanced = (source, start, open = '{', close = '}') => {
  if (source[start] !== open) return { value: source[start] || '', end: Math.min(source.length, start + 1) };
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === open) depth += 1;
    else if (source[index] === close) {
      depth -= 1;
      if (!depth) return { value: source.slice(start + 1, index), end: index + 1 };
    }
  }
  return { value: source.slice(start + 1), end: source.length };
};

const readArgument = (source, start) => {
  let cursor = start;
  while (/\s/.test(source[cursor] || '')) cursor += 1;
  if (source[cursor] === '{') return readBalanced(source, cursor);
  if (source[cursor] === '\\') {
    const command = readCommand(source, cursor);
    return { value: `\\${command.value}`, end: command.end };
  }
  return { value: source[cursor] || '', end: Math.min(source.length, cursor + 1) };
};

const appendText = (segments, text) => {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last?.type === 'text') last.text += text;
  else segments.push({ type: 'text', text });
};

const commandText = (command) => Object.prototype.hasOwnProperty.call(COMMAND_TEXT, command)
  ? COMMAND_TEXT[command]
  : command;

// 普通英文填空（如 "There ___ a book"）中的下划线不是数学下标。
// 只有当前后都具备数学 token 时才按下标解析，避免把连续下划线和后面的单词吞掉。
const isSubscriptMarker = (source, index) => {
  const previous = source[index - 1] || '';
  const next = source[index + 1] || '';
  if (!/[A-Za-z0-9)\]}]/.test(previous) || previous === '_') return false;
  return /[A-Za-z0-9({[\\]/.test(next);
};

const flattenMath = (value) => parseMath(value).map((segment) => {
  if (segment.type === 'text') return segment.text;
  if (segment.type === 'sup' || segment.type === 'sub') {
    const map = segment.type === 'sup' ? SUPERSCRIPT : SUBSCRIPT;
    return [...segment.text].map((character) => map[character] || character).join('');
  }
  if (segment.type === 'root') return `${segment.degreeText || ''}√${flattenMath(segment.radicand)}`;
  if (segment.type === 'fraction') return `(${flattenMath(segment.numerator)})/(${flattenMath(segment.denominator)})`;
  if (segment.type === 'overline') return flattenMath(segment.value);
  if (segment.type === 'accent') return segment.text;
  return '';
}).join('').replace(/[{}]/g, '');

export const parseMath = (input) => {
  const source = String(input || '').replace(/\$/g, '').replace(/\\,/g, ' ').replace(/\\;/g, ' ');
  const segments = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') {
      const command = readCommand(source, index);
      index = command.end;
      if (command.value === 'frac' || command.value === 'dfrac' || command.value === 'tfrac') {
        const numerator = readArgument(source, index);
        const denominator = readArgument(source, numerator.end);
        const numeratorText = flattenMath(numerator.value);
        const denominatorText = flattenMath(denominator.value);
        segments.push({ type: 'fraction', numerator: numerator.value, denominator: denominator.value,
          numeratorText, denominatorText, fallbackText: `(${numeratorText})/(${denominatorText})`,
          numeratorSegments: parseMath(numerator.value), denominatorSegments: parseMath(denominator.value) });
        index = denominator.end;
      } else if (command.value === 'sqrt') {
        let degreeText = '';
        if (source[index] === '[') {
          const degree = readBalanced(source, index, '[', ']');
          degreeText = flattenMath(degree.value);
          index = degree.end;
        }
        const radicand = readArgument(source, index);
        const radicandText = flattenMath(radicand.value);
        segments.push({ type: 'root', radicand: radicand.value, radicandText,
          radicandSegments: parseMath(radicand.value), degreeText, fallbackText: `${degreeText}√${radicandText}` });
        index = radicand.end;
      } else if (command.value === 'overline' || command.value === 'bar') {
        const argument = readArgument(source, index);
        segments.push({ type: 'overline', value: argument.value, text: flattenMath(argument.value), fallbackText: flattenMath(argument.value),
          segments: parseMath(argument.value) });
        index = argument.end;
      } else if (['vec', 'overrightarrow', 'hat', 'widehat'].includes(command.value)) {
        const argument = readArgument(source, index);
        const suffix = command.value === 'hat' || command.value === 'widehat' ? '\u0302' : '\u20d7';
        segments.push({ type: 'accent', text: `${flattenMath(argument.value)}${suffix}` });
        index = argument.end;
      } else if (['mathrm', 'mathbf', 'mathit', 'operatorname'].includes(command.value)) {
        const argument = readArgument(source, index);
        appendText(segments, flattenMath(argument.value));
        index = argument.end;
      } else appendText(segments, commandText(command.value));
      continue;
    }
    if (character === '^' || (character === '_' && isSubscriptMarker(source, index))) {
      const argument = readArgument(source, index + 1);
      segments.push({ type: character === '^' ? 'sup' : 'sub', text: flattenMath(argument.value) });
      index = argument.end;
      continue;
    }
    if (character === '{' || character === '}') {
      index += 1;
      continue;
    }
    appendText(segments, character);
    index += 1;
  }
  return segments.filter((segment) => segment.type !== 'text' || segment.text);
};
