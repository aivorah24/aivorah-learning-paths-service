// Generic OpenAI-compatible chat-completions caller — native fetch, no SDK dep.
// Used for the knowledge tier's LLM, which is provider-agnostic (Groq/Gemini/
// anything else that speaks this API shape). Callers must fall back to the
// existing Groq gpt-oss-120b path on any thrown error (rate limit, no key, etc.).
async function callLLM(prompt, { json = false, baseUrl, apiKey, model } = {}) {
  if (!apiKey) throw new Error('No API key configured for knowledge-tier LLM');
  if (!baseUrl) throw new Error('No base URL configured for knowledge-tier LLM');

  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
  };
  if (json) body.response_format = { type: 'json_object' };

  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Knowledge-tier LLM request failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Knowledge-tier LLM response had no content');
  return content;
}

module.exports = { callLLM };
