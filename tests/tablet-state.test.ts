import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {venueStateError} from "../lib/venue-errors";

// Isolate request-bound Next imports while exercising the actual route handler,
// including rejected promises returned by its asynchronous state loader.
function handler(error: { code: string; message: string }, enrolled = true) {
  const source = readFileSync(new URL("../app/api/tablet/route.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: { GET?: (request: Request) => Promise<Response> } = {};
  runInNewContext(compiled, {
    exports, URL,
    console: { error() {} },
    require(name: string) {
      if (name === "@/lib/venue-errors") return {venueStateError};
      if (name === "@/lib/browser-tablets") return {
        browserTablet: async () => enrolled ? { device: { id: "device" }, kiosk: {} } : null,
      };
      if (name === "@/lib/recorder-server") return {
        recorderDatabase: () => ({ from: () => {
          const query = {
            select: () => query, eq: () => query, order: () => query,
            maybeSingle: async () => ({ data: null, error }),
            single: async () => ({ data: null, error }),
            limit: async () => ({ data: null, error }),
          };
          return query;
        } }),
      };
      if (name === "@/lib/http") return { json: (body: unknown, status = 200) => Response.json(body, {status}) };
      return {};
    },
  });
  return exports.GET!;
}

test("tablet setup returns actionable JSON when its queue schema is missing", async () => {
  const response = await handler({code:"42703",message:"Internal missing column details"})(new Request("http://localhost/api/tablet?setup=1"));
  assert.equal(response.status,503);
  const body = await response.json();
  assert.match(body.error,/database update/);
  assert.doesNotMatch(body.error,/Internal missing column details/);
});

test("asynchronous tablet state failures stay inside the JSON error handler", async () => {
  const response = await handler({code:"08006",message:"Internal database details"})(new Request("http://localhost/api/tablet?setup=1"));
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{error:"Tablet connection unavailable. Please retry."});
});

test("unenrolled browser still receives the setup enrollment response", async () => {
  const response = await handler({code:"PGRST202",message:"Missing RPC"},false)(new Request("http://localhost/api/tablet?setup=1"));
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{enabled:false});
});

test("kiosk awaits tablet state rejection and returns safe JSON", async () => {
  const source = readFileSync(new URL("../app/api/kiosk/route.ts", import.meta.url), "utf8");
  const exports: { GET?: () => Promise<Response> } = {};
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: {module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText, {
    exports, console:{error(){}},
    require(name:string) {
      if(name === "@/lib/browser-tablets")return {browserTablet:async()=>({device:{id:"device"},kiosk:{}})};
      if(name === "../tablet/route")return {browserTabletState:async()=>{throw {code:"08006",message:"Private database details"};}};
      if(name === "@/lib/venue-errors")return {venueStateError};
      if(name === "@/lib/http")return {json:(body:unknown,status=200)=>Response.json(body,{status})};
      return {};
    },
  });
  const response=await exports.GET!();
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{error:"Cannot reach the venue. Please retry."});
});
