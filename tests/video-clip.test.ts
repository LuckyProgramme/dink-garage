import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {lastMinuteRange,cutLastMinute} from "../lib/video-clip";

test("last minute uses source duration, clamps short sources and rejects invalid timelines",()=>{
  assert.deepEqual(lastMinuteRange(900000),{startMs:840000,durationMs:60000});
  assert.deepEqual(lastMinuteRange(60000),{startMs:0,durationMs:60000});
  assert.deepEqual(lastMinuteRange(1234),{startMs:0,durationMs:1234});
  for(const bad of [0,-1,NaN,Infinity])assert.throws(()=>lastMinuteRange(bad));
});
test("short clip export retains original valid bytes instead of inventing a one-minute file",async()=>{
  const data=await readFile("tests/fixtures/recording-one-second.mp4"),source=new Blob([data]);
  const result=await cutLastMinute(source,{} as HTMLVideoElement,true,new AbortController().signal,()=>{});
  assert.equal(result.blob,source);assert.equal(result.durationMs,1000);assert.equal(result.startMs,0);
});
