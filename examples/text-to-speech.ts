import { createGenerationClient } from "../src/index.js";

const apiKey = process.env.NETA_ROUTER_API_KEY ?? process.env.NETA_API_KEY;
if (!apiKey) throw new Error("Set NETA_ROUTER_API_KEY or NETA_API_KEY");

const client = createGenerationClient({ apiKey });
const output = await client.generate({
  model: "qwen-audio-3.0-tts-plus",
  content: [{ type: "text", text: "欢迎使用语音合成功能，这是一段示例文本。" }],
  meta: {
    voice_prompt: "一位沉稳自然的中文播音员，吐字清晰，语速适中",
  },
});

console.log(output);
