// Forge entry point.
//
// This file only owns the trial lifecycle: start the HTTP server built by
// app.ts on an ephemeral port, tell the trial suite which port that is,
// then keep asking the suite whether the trial is over until it says so.
// All request handling (git, REST, GraphQL, MCP) lives in app.ts, and the
// shop token the suite presents is read inside createApp, so nothing here
// touches authentication directly.
//
// Exit contract: 0 once the suite answers done, non-zero (with a message
// on stderr) if anything in the lifecycle fails first.

import { createApp } from "./app.ts";

const SUITE_URL = process.env.MAKEFUN_ENV_URL ?? "";
const DONE_POLL_MS = 250;

type ListeningForge = {
  port: number;
  shutdown: () => Promise<void>;
};

function listenOnEphemeral(): Promise<ListeningForge> {
  const forge = createApp();
  return new Promise<ListeningForge>((resolve, reject) => {
    forge.once("error", reject);
    forge.listen(0, "127.0.0.1", () => {
      const bound = forge.address();
      if (bound === null || typeof bound === "string") {
        reject(new Error("server came up without a numeric port"));
        return;
      }
      resolve({
        port: bound.port,
        shutdown: () =>
          new Promise<void>((done) => {
            forge.close(() => done());
          }),
      });
    });
  });
}

async function registerWithSuite(port: number): Promise<void> {
  const payload = JSON.stringify({ port });
  let answer: Response;
  try {
    answer = await fetch(`${SUITE_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`register request never reached the suite (${why})`);
  }
  if (answer.ok === false) {
    throw new Error(`suite refused the registration (HTTP ${answer.status})`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((wake) => setTimeout(wake, ms));
}

async function waitForDone(): Promise<void> {
  for (;;) {
    let answer: Response;
    try {
      answer = await fetch(`${SUITE_URL}/done`);
    } catch (cause) {
      const why = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`done poll never reached the suite (${why})`);
    }
    if (answer.ok === false) {
      throw new Error(`done poll failed (HTTP ${answer.status})`);
    }
    const payload = (await answer.json()) as { done?: unknown };
    if (payload.done === true) {
      return;
    }
    await sleep(DONE_POLL_MS);
  }
}

async function runForge(): Promise<void> {
  if (SUITE_URL === "") {
    throw new Error("MAKEFUN_ENV_URL is unset, so there is no suite to join");
  }
  const forge = await listenOnEphemeral();
  try {
    await registerWithSuite(forge.port);
    await waitForDone();
  } finally {
    await forge.shutdown();
  }
}

runForge().catch((cause: unknown) => {
  const why = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`forge: lifecycle failed: ${why}\n`);
  process.exitCode = 1;
});
