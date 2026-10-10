import { expect, it } from "vitest";
import { choice, createGenerationClient, noul, score } from "../../src/index.js";

it("evaluates typed questions through the configured System One endpoint", async () => {
  const apiKey = process.env.JEV_API_KEY;
  const baseURL = process.env.JEV_BASE_URL;
  if (!apiKey || !baseURL) throw new Error("JEV_API_KEY and JEV_BASE_URL are required");
  const client = createGenerationClient({
    apiKey,
    systemOne: { baseURL, timeout: 60_000, retry: { maxRetries: 0 } },
  });
  const call = client.systemOne({
    model: process.env.JEV_MODEL ?? "jev-latest",
    state: { ticket: "I was charged twice for my subscription.", enabled: false, optional: null },
    questions: {
      refund: noul("Does the customer need a refund?"),
      team: choice("Which team?", { billing: "Charges and refunds", technical: "Bugs and outages" }),
      urgency: score("How urgent?", ["Can wait", "Needs attention"]),
    },
  });
  const { data, response } = await call.withResponse();
  expect(response.status).toBe(200);
  expect(data.model).toBeTruthy();
  expect(data.answers.refund.noul).toBeGreaterThanOrEqual(0);
  expect(data.answers.refund.noul).toBeLessThanOrEqual(1);
  expect(["billing", "technical"]).toContain(data.answers.team.choice);
  expect(data.answers.urgency.score).toBeGreaterThanOrEqual(0);
  expect(data.answers.urgency.score).toBeLessThanOrEqual(1);
  expect(Number.isInteger(data.usage.input_tokens)).toBe(true);
  expect(data.usage.input_tokens).toBeGreaterThan(0);
  expect(data.usage.output_tokens).toBeGreaterThanOrEqual(0);
}, 70_000);
