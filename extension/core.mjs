const QUESTION_TYPES = new Set(['auto', 'single', 'multiple', 'judgment']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const IMAGE_LIMIT = 8 * 1024 * 1024;
const TOTAL_IMAGE_LIMIT = 20 * 1024 * 1024;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function stripMarkdown(value) {
  return value.trim().replace(/^(?:>\s*|#{1,6}\s+|[-*+]\s+)+/, '')
    .replace(/\*\*|__|`|\*/g, '').trim().replace(/^_([^_\r\n]+)_$/, '$1');
}

function unwrapFence(value) {
  const match = value.trim().match(/^```(?:text|plaintext)?\s*\n([\s\S]*?)\n```$/i);
  return match ? match[1].trim() : value.trim();
}

/** Recognize an explicit abstention line, never uncertainty mentioned within reasoning. */
export function isUncertainResponse(text) {
  return typeof text === 'string' && text.split(/\r?\n/).some(line => {
    const token = stripMarkdown(line).replace(/^(?:(?:最终)?答案\s*[:：]\s*|【\s*(?:最终)?答案\s*】\s*[:：]?\s*)/, '');
    return /^(?:无法确认\s*[:：]\s*|【\s*无法确认\s*】\s*[:：]?\s*)/.test(token)
      || /^无法确认(?:\s*[（(][^（）()\r\n]*[）)])?\s*[。.!！]?\s*$/.test(token);
  });
}

/** Normalize only a supplied answer token; prose and ambiguous alternatives fail closed. */
export function normalizeAnswer(value, type) {
  if (typeof value !== 'string' || !QUESTION_TYPES.has(type)) return null;
  const token = stripMarkdown(value);
  if (!token || /[\r\n]/.test(token)) return null;
  if (type === 'auto' && (token === '正确' || token === '错误')) return token;
  if (type === 'judgment') {
    if (/^(?:正确|对|是|true|yes|√|✓|✅)$/i.test(token)) return '正确';
    if (/^(?:错误|错|否|false|no|×|✗|❌)$/i.test(token)) return '错误';
    return null;
  }
  const letters = token.replace(/[\s,，、;/；]+/g, '').toUpperCase();
  if (!/^[A-H]+$/.test(letters)) return null;
  if (type === 'single') return letters.length === 1 ? letters : null;
  return [...new Set(letters)].sort().join('');
}

function normalizeFinalAnswer(value, type) {
  const clean=value.normalize('NFKC').trim();
  if(/[?？]/.test(clean.split(/[。！!]/)[0]))return null;
  const unpunctuated=clean.replace(/[。.!！；;]+\s*$/, '').trim();
  const plain=unpunctuated.replace(/\s*[✅☑✔✓]\uFE0F?\s*$/, '').trim();
  const answer=normalizeAnswer(clean,type)??normalizeAnswer(unpunctuated,type)??normalizeAnswer(plain,type);
  if (answer !== null) return answer;
  // An explicit final line may repeat the option text, e.g. "B.PICO 分析".
  const labeled = plain.match(/^([A-H]+(?:[\s,，、;/；]+[A-H]+)*)\s*[.．、:：)），,。；;]\s*(\S.*)$/i);
  if (labeled) {
    const description = labeled[2];
    if (/^(?:可能(?:是|为|选)|也许|不确定|无法确认|不能确认|无法确定|不能确定|待确认|待核实|待核验|maybe\b|perhaps\b|uncertain\b)/i.test(description)
      || /也(?:有)?可能|不太确定|无法确认|不能确认|无法确定|不能确定/.test(description)
      || /(?:^|[\s，,；;。、])[A-H]\s*[.．、:：)）]\s*\S/i.test(description)
      || /(?:或(?:者)?|还是|\bor\b)\s*(?:选项\s*)?[A-H](?=$|[\s.．、:：)），,；;])/i.test(description)
      || /[A-H]\s*[/／]\s*[A-H](?=$|[\s.．、:：)），,；;])/i.test(description)) return null;
    return normalizeAnswer(labeled[1], type);
  }
  // Parentheses can repeat the selected option name; English letters there are not extra choices.
  const explained = plain.match(/^(.+?)\s*\(\s*(?:即\s*)?([^（）()\r\n]+)\)\s*$/);
  if (!explained) return null;
  const explanation = explained[2];
  if (!explanation.trim() || /或|可能|也许|不确定|无法确认|不能确认|无法确定|不能确定|待确认|待核实|待核验/.test(explanation)) return null;
  return normalizeAnswer(explained[1], type);
}

/** Read explicit answer declarations or conclusions, never arbitrary option letters in prose. */
export function extractAnswer(text, type) {
  if (typeof text !== 'string' || !QUESTION_TYPES.has(type) || isUncertainResponse(text)) return null;
  const lines = text.split(/\r?\n/).map(stripMarkdown);
  const finals = [];
  const markers=[
    /(?:^|[，,。；;！!？?\s])(?:【\s*(?:最终|正确)?答案\s*】\s*[:：]?\s*|(?:(?:本题|此题|该题)(?:的)?\s*)?(?:(?:最终|正确)?答案|正确选项)\s*(?:[:：]\s*|(?:应(?:当)?(?:为|是)|为|是)\s*[:：]?\s*))/g,
    /(?:^|[，,。；;！!？?\s])(?:(?:因此|所以|故|综上(?:所述)?)\s*[，,:：]?\s*(?:本题\s*)?|本题\s*)(?:应选|选择|选)\s*[:：]?\s*/g
  ];
  for (let index = 0; index < lines.length; index++) {
    const line=lines[index];
    for(const marker of markers)for(const match of line.matchAll(marker)){
      const context=line.slice(0,match.index).split(/[。！？!?；;]/).at(-1);
      if(/(?:^|[，,\s])(?:如果|假如|假设|例如|比如|举例|示例)/.test(context))continue;
      const value=line.slice(match.index+match[0].length).trim()||lines[index+1]||'';
      finals.push(normalizeFinalAnswer(value,type));
    }
  }
  if (finals.length) {
    if (finals.some(answer => answer === null)) return null;
    return new Set(finals).size === 1 ? finals[0] : null;
  }
  return normalizeAnswer(unwrapFence(text), type);
}

function completedAnswer(result) {
  if (!result || result.status !== 'completed' || isUncertainResponse(result.text)) return null;
  return normalizeAnswer(result.answer, 'judgment') ?? normalizeAnswer(result.answer, 'multiple');
}

/** Show the most common completed answer among enabled voters. */
export function recommend(results = {}, providers = []) {
  const configured = Array.isArray(providers) ? providers : [];
  // Duplicate configuration entries must never give one provider multiple votes.
  const voters = [...new Map(configured.filter(provider => provider?.enabled === true && provider.voting === true)
    .map(provider => [provider.id, provider])).values()];
  const outcome = (status, leaders = []) => ({
    status,
    answer: leaders.length === 1 ? leaders[0].answer : null,
    supporters: leaders.length === 1 ? leaders[0].supporters : [],
    votes: leaders[0]?.supporters.length ?? 0,
    leaders,
  });
  if (!voters.length) return outcome('no_voters');

  const groups = new Map();
  let pending = false;
  for (const provider of voters) {
    const result = results?.[provider.id];
    const answer = completedAnswer(result);
    if (answer) {
      if (!groups.has(answer)) groups.set(answer, []);
      groups.get(answer).push(provider.id);
    } else if (!(result?.replyFinished || result?.status === 'completed' || result?.status === 'error' || result?.status === 'uncertain')) {
      pending = true;
    }
  }
  if (groups.size) {
    const mostVotes = Math.max(...[...groups.values()].map(supporters => supporters.length));
    const leaders = [...groups].filter(([, supporters]) => supporters.length === mostVotes)
      .map(([answer, supporters]) => ({ answer, supporters }))
      .sort((a, b) => a.answer.localeCompare(b.answer));
    return outcome(leaders.length === 1 ? 'plurality' : 'tie', leaders);
  }
  return outcome(pending ? 'pending' : 'incomplete');
}

function decodedSize(dataUrl, mime) {
  const prefix = `data:${mime};base64,`;
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) return null;
  const payload = dataUrl.slice(prefix.length);
  if (!payload.length || payload.length > Math.ceil(IMAGE_LIMIT / 3) * 4 || payload.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null;
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  // Canonical pad bits prevent permissive decoders from accepting malformed data.
  if (padding === 2 && (BASE64_ALPHABET.indexOf(payload.at(-3)) & 15) !== 0) return null;
  if (padding === 1 && (BASE64_ALPHABET.indexOf(payload.at(-2)) & 3) !== 0) return null;
  return payload.length / 4 * 3 - padding;
}

/** Validate without decoding images into duplicate byte buffers. */
export function validateQuestion(question) {
  if (!question || typeof question !== 'object' || Array.isArray(question)) return ['题目格式无效。'];
  const errors = [];
  if (!QUESTION_TYPES.has(question.type)) errors.push('请选择不限定题型、单选、多选或判断题。');
  if (typeof question.text !== 'string') errors.push('题目文字格式无效。');
  else if (question.text.length > 30000) errors.push('题目文字不能超过 30000 个字符。');
  if (!Array.isArray(question.images)) {
    errors.push('图片列表格式无效。');
    return errors;
  }
  if (!(typeof question.text === 'string' && question.text.trim()) && !question.images.length) errors.push('请输入题目文字或添加原图。');
  if (question.images.length > 4) errors.push('每题最多添加 4 张图片。');
  let total = 0;
  question.images.slice(0, 4).forEach((image, index) => {
    const label = `第 ${index + 1} 张图片`;
    if (!image || typeof image !== 'object' || Array.isArray(image)) {
      errors.push(`${label}格式无效。`);
      return;
    }
    if (typeof image.name !== 'string' || !image.name.trim()) errors.push(`${label}缺少文件名。`);
    if (!IMAGE_TYPES.has(image.mime)) errors.push(`${label}仅支持 PNG、JPEG、WEBP 或 GIF。`);
    if (!Number.isSafeInteger(image.size) || image.size <= 0 || image.size > IMAGE_LIMIT) {
      errors.push(`${label}大小无效或超过 8 MiB。`);
    }
    const bytes = IMAGE_TYPES.has(image.mime) ? decodedSize(image.dataUrl, image.mime) : null;
    if (bytes === null || bytes !== image.size) errors.push(`${label}原图数据无效或与文件大小不一致。`);
    if (bytes !== null) total += bytes;
  });
  if (total > TOTAL_IMAGE_LIMIT) errors.push('图片总大小不能超过 20 MiB。');
  return errors;
}

export function buildPrompt(question, {includeInstructions = true} = {}) {
  const rule = [
    '这是连续答题任务。以下规则对本会话从现在起的每一道题持续生效，后续不再重复。每条消息的文字和所附全部图片组成一道独立题目，只回答当题，不沿用上一题答案。',
    '请在内部完成审题、核实和推理。回复正文必须只有一行纯文本，且只用以下一种格式：',
    '选择题：答案：选项字母。单选只填一个大写字母，多选将全部正确选项按字母顺序紧连，例如“答案：B”或“答案：AC”。',
    '判断题：只回复“答案：A”或“答案：B”，按题目中的选项对应关系作答。',
    '没有可靠依据、题目信息不足或无法确定：只回复“无法确认”，不得猜测或编造，也不要追问。',
    '“答案：”和结果必须在同一行，不换行、不加空行。除这一行外不得输出任何内容：不附选项原文、解析、来源、引用、链接、标题、表格、Markdown、表情、客套话、追问或继续服务的建议。即使题目要求说明，也只按上述格式作答。不要确认收到，不要复述规则，直接回答本条题目。',
    '本题：'
  ].join('\n');
  const text = typeof question?.text === 'string' ? question.text : '';
  return [includeInstructions ? rule : '', text].filter(part => part !== '').join('\n');
}
