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
    const token = stripMarkdown(line).replace(/^(?:最终答案\s*[:：]\s*|【\s*最终答案\s*】\s*[:：]?\s*)/, '');
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
  // Some webpages decorate an explicit final answer with a trailing check mark.
  const answer = normalizeAnswer(value, type) ?? normalizeAnswer(value.replace(/\s*[✅☑✔✓]\uFE0F?\s*$/, ''), type);
  if (answer !== null) return answer;
  // GLM may append an "即..." explanation to its explicit final token. Keep other prose strict.
  const explained = value.match(/^(.+?)\s*(?:（\s*即\s*([^（）()\r\n]+)）|\(\s*即\s*([^（）()\r\n]+)\))\s*[。.]?\s*$/);
  if (!explained) return null;
  const explanation = explained[2] ?? explained[3];
  if (!explanation.trim() || /或|可能|也许|不确定|无法确认|不能确认|无法确定|不能确定|待确认|待核实|待核验/.test(explanation)) return null;
  return normalizeAnswer(explained[1], type);
}

/** Never mine option letters from reasoning. Conflicting final lines are ambiguous. */
export function extractAnswer(text, type) {
  if (typeof text !== 'string' || !QUESTION_TYPES.has(type) || isUncertainResponse(text)) return null;
  const lines = text.split(/\r?\n/).map(stripMarkdown);
  const finals = [];
  for (const line of lines) {
    const match = line.match(/^(?:最终答案\s*[:：]\s*|【\s*最终答案\s*】\s*[:：]?\s*)(.*)$/);
    if (match) finals.push(normalizeFinalAnswer(match[1], type));
  }
  if (finals.length) {
    if (finals.some(answer => answer === null)) return null;
    return new Set(finals).size === 1 ? finals[0] : null;
  }
  // Qwen sometimes ends with "答案：B" or "答案：\nB". Do not infer answers from prose.
  const answers = [];
  let lastAnswerLine = -1;
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^答案\s*[:：]\s*(.*)$/);
    if (!match) continue;
    lastAnswerLine = match[1] ? index : index + 1;
    answers.push(normalizeAnswer(match[1] || lines[index + 1] || '', type));
  }
  if (answers.length) {
    const lastTextLine = lines.findLastIndex(line => line !== '');
    if (lastAnswerLine !== lastTextLine || answers.some(answer => answer === null)) return null;
    return new Set(answers).size === 1 ? answers[0] : null;
  }
  return normalizeAnswer(unwrapFence(text), type);
}

function completedAnswer(result) {
  if (!result || result.status !== 'completed' || isUncertainResponse(result.text)) return null;
  return normalizeAnswer(result.answer, 'judgment') ?? normalizeAnswer(result.answer, 'multiple');
}

/** Vote against all enabled voters, including ones that failed or have not completed. */
export function recommend(results = {}, providers = [], fallbackId = 'glm') {
  const configured = Array.isArray(providers) ? providers : [];
  // Duplicate configuration entries must never give one provider multiple votes.
  const voters = [...new Map(configured.filter(provider => provider?.enabled === true && provider.voting === true)
    .map(provider => [provider.id, provider])).values()];
  const enabledFallback = configured.some(provider => provider?.id === fallbackId && provider.enabled === true);
  const provisionalAnswer = enabledFallback ? completedAnswer(results?.[fallbackId]) : null;
  const outcome = (status, answer, supporters, reason) => ({ status, answer, supporters, reason, provisionalAnswer });
  if (!voters.length) return outcome('no_voters', null, [], '没有已启用的投票模型。');

  const groups = new Map();
  let invalid = false;
  let pending = false;
  for (const provider of voters) {
    const result = results?.[provider.id];
    const answer = completedAnswer(result);
    if (answer) {
      if (!groups.has(answer)) groups.set(answer, []);
      groups.get(answer).push(provider.id);
    } else if (result?.status === 'completed' || result?.status === 'error' || result?.status === 'uncertain') {
      invalid = true;
    } else {
      pending = true;
    }
  }
  for (const [answer, supporters] of groups) {
    if (supporters.length > voters.length / 2) {
      return outcome('majority', answer, supporters, `${supporters.length}/${voters.length} 个投票模型的完整答案一致，已严格过半。`);
    }
  }
  if (invalid) return outcome('incomplete', null, [], '存在弃答、失败或无法提取有效答案的投票模型；结果不完整。');
  if (pending) return outcome('pending', null, [], '尚未严格过半，等待其余投票模型完成并确认有效答案。');
  if (provisionalAnswer) return outcome('fallback', provisionalAnswer, [fallbackId], '全部投票模型已有有效答案但未严格过半，采用 GLM 兜底答案。');
  return outcome('incomplete', null, [], '全部投票模型已完成但未严格过半，GLM 兜底答案不可用。');
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

export function buildPrompt(question) {
  const rule = '仅回答本题：有可靠依据时输出“最终答案：完整答案”（选择题填全部选项字母，判断题填正确或错误）；找不到可靠依据或无法确定时输出“无法确认：具体原因”，不得猜测、编造或沿用上一题答案。';
  const imageCount = Array.isArray(question?.images) ? question.images.length : 0;
  const imageInstruction = imageCount ? `已附 ${imageCount} 张原图，请结合本题全部图片和文字作答。` : '';
  const text = typeof question?.text === 'string' ? question.text : '';
  return [rule, imageInstruction, text].filter(part => part !== '').join('\n');
}
