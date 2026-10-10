import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  APIUserAbortError,
  choice,
  createGenerationClient,
  createGenerationClientFromFile,
  GenerationConfigError,
  type GenerationDebugEvent,
  noul,
  parseGenerationModelDeclaration,
  type SystemOneRequest,
  score,
  TypeSafeError,
} from "../src/index.js";

describe("System One", () => {
  it("discovers and roundtrips Jev declarations without credentials", async () => {
    const client = createGenerationClient();
    const models = client.listModels().filter((model) => model.category === "decision");
    expect(models.map((model) => model.model)).toEqual(["jev-1.13", "jev-latest"]);
    for (const model of models) {
      expect(model.adapter.type).toBe("typesafe.systemOne");
      expect(model.systemOneExamples?.[0]?.request.model).toBe(model.model);
      expect(parseGenerationModelDeclaration(client.stringifyModelConfig(model.model))).toEqual(model);
    }
    const first = models[0];
    if (!first) throw new Error("Jev model declaration is missing");
    first.model = "changed";
    expect(client.getModel("jev-1.13")?.model).toBe("jev-1.13");
    const fromFile = await createGenerationClientFromFile("models/jev-latest.yaml");
    expect(fromFile.getModel("jev-latest")).toEqual(client.getModel("jev-latest"));
    expectTypeOf(fromFile.systemOne).toEqualTypeOf<TypeSafeClient["systemOne"]>();
  });

  it("uses the configured catalog and rejects mismatched entry points before transport", async () => {
    const request = { state: null, questions: { check: noul("Is this valid?") } };
    const client = createGenerationClient();
    expect(() => client.systemOne(request)).toThrow("apiKey is required");
    expect(() => createGenerationClient({ includeBuiltinModels: false }).systemOne(request)).toThrow(
      "Generation model is unavailable: jev-latest",
    );
    expect(() => client.systemOne({ ...request, model: "gpt-image-2" })).toThrow("does not support systemOne()");
    expect(() => client.validate({ model: "jev-latest", content: [] })).toThrow("requires systemOne()");
    await expect(client.generate({ model: "jev-latest", content: [] })).rejects.toBeInstanceOf(GenerationConfigError);
  });

  it("preserves official question validation", () => {
    const client = createGenerationClient({ apiKey: "local-validation" });
    expect(() => client.systemOne({ state: null, questions: {} })).toThrow(TypeSafeError);
  });

  it("rejects invalid System One example envelopes from configuration", () => {
    const declaration = createGenerationClient().getModel("jev-latest");
    for (const examples of [null, {}, [null], [{ request: {} }], [{ request: { state: null, questions: [] } }]]) {
      expect(() =>
        parseGenerationModelDeclaration(JSON.stringify({ ...declaration, systemOneExamples: examples }), "jev.json"),
      ).toThrow("Invalid model declaration");
    }
  });

  for (const target of ["gateway", "systemOne"] as const) {
    it(`sends ordered JSON and honors cancellation over a real ${target} HTTP connection`, async () => {
      let resolveRequest: (value: { path: string; method: string; headers: IncomingHttpHeaders; body: string }) => void;
      const received = new Promise<{ path: string; method: string; headers: IncomingHttpHeaders; body: string }>(
        (resolve) => {
          resolveRequest = resolve;
        },
      );
      const server = createServer((request) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () =>
          resolveRequest({
            path: request.url ?? "",
            method: request.method ?? "",
            headers: request.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      });
      const controller = new AbortController();
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("HTTP listener has no address");
      const origin = `http://127.0.0.1:${address.port}`;
      const events: GenerationDebugEvent[] = [];
      const client = createGenerationClient({
        apiKey: "local-http-credential",
        baseUrl: `${origin}/prefix/`,
        fetch: globalThis.fetch,
        systemOne: {
          ...(target === "systemOne" ? { baseURL: `${origin}/api/` } : {}),
          defaultModel: "jev-1.13",
          retry: { maxRetries: 0 },
          timeout: 5000,
        },
        debug: { enabled: true, logger: (event) => events.push(event) },
      });
      const input = {
        state: { z: false, a: null, nested: { later: 0, earlier: "kept" } },
        questions: {
          check: noul("Does the statement describe water?"),
          team: choice("Which team?", { billing: "Charges", technical: null }),
          severity: score("How severe?", ["low", "high"]),
        },
        provider: { allow_fallbacks: false },
      };
      try {
        const call = client.systemOne(input, { signal: controller.signal, headers: { "X-Request-Test": "ordered" } });
        expectTypeOf(client.systemOne).toEqualTypeOf<TypeSafeClient["systemOne"]>();
        expectTypeOf<Awaited<typeof call>["answers"]["team"]["choice"]>().toEqualTypeOf<"billing" | "technical">();
        expectTypeOf<Awaited<typeof call>["answers"]["severity"]["score"]>().toEqualTypeOf<number>();
        expectTypeOf(input).toMatchTypeOf<SystemOneRequest>();
        const outcome = call.then(
          (value) => value,
          (error: unknown) => error,
        );
        const actual = await received;
        expect(actual.path).toBe(target === "gateway" ? "/prefix/typesafe/v1/systemone" : "/api/v1/systemone");
        expect(actual.method).toBe("POST");
        expect(actual.headers.authorization).toBe("Bearer local-http-credential");
        expect(actual.headers["x-request-test"]).toBe("ordered");
        expect(actual.headers["x-typesafe-sdk"]).toBe("typesafe-sdk/0.6.0");
        expect(actual.body).toBe(JSON.stringify({ ...input, model: "jev-1.13" }));
        expect(JSON.stringify(events)).not.toContain("local-http-credential");
        expect(events[0]?.type).toBe("request");
        expect(typeof call.withResponse).toBe("function");
        expect(typeof call.asResponse).toBe("function");
        controller.abort();
        expect(await outcome).toBeInstanceOf(APIUserAbortError);
      } finally {
        controller.abort();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      }
    });
  }
});
