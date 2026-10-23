import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import ts from "typescript";
import {randomUUID} from "node:crypto";
import {InputError,text,uuid} from "../lib/validation";

test("tenant routes reject forged switches, player administration and cross-origin requests",async()=>{
  const tenant=randomUUID(),other=randomUUID(),user=randomUUID(),calls:any[]=[],cookies:any[]=[];
  let account:any={id:user,tenantId:tenant,role:"player",isSuperAdmin:false,tenants:[{id:tenant,role:"player"}]};
  let same=true;
  const exports:any={};
  runInNewContext(ts.transpileModule(readFileSync("app/api/tenants/route.ts","utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
    exports,process:{env:{NODE_ENV:"production"}},
    require(name:string){
      if(name==="@/lib/auth")return{getAccount:async()=>({account})};
      if(name==="next/headers")return{cookies:async()=>({set:(...args:any[])=>cookies.push(args)})};
      if(name==="@/lib/tenant-scope")return{TENANT_COOKIE:"dinkvision-tenant"};
      if(name==="@/lib/validation")return{InputError,text,uuid};
      if(name==="@/lib/http")return{sameOrigin:()=>same,readBody:(r:Request)=>r.json(),json:(body:unknown,status=200)=>Response.json(body,{status})};
      if(name==="@/lib/recorder-server")return{
        recorderDatabase:(scope:string)=>({rpc:async(fn:string,args:any)=>{calls.push({scope,fn,args});return{data:null,error:null};}}),
        systemDatabase:()=>({rpc:async(fn:string,args:any)=>{calls.push({fn,args});return{data:other,error:null};}}),
      };
      throw Error(name);
    },
  });
  const post=(body:any)=>exports.POST(new Request("https://test.local/api/tenants",{method:"POST",body:JSON.stringify(body)}));
  assert.equal((await post({action:"switch",tenant_id:other})).status,403);assert.equal(cookies.length,0);
  assert.equal((await post({action:"google",owner_email:"x@gmail.com",root_folder_id:"someFolder"})).status,403);assert.equal(calls.length,0);
  same=false;assert.equal((await post({action:"create",name:"Club",slug:"club"})).status,403);same=true;
  assert.equal((await post({action:"switch",tenant_id:tenant})).status,200);
  assert.equal(cookies[0][1],tenant);assert.equal(cookies[0][2].httpOnly,true);assert.equal(cookies[0][2].secure,true);
  account={...account,role:"admin"};
  assert.equal((await post({action:"membership",tenant_id:other,actor_id:other,email:"member@gmail.com",role:"player",active:false})).status,200);
  assert.equal(calls[0].scope,tenant);assert.equal(calls[0].args.p_tenant,tenant);assert.equal(calls[0].args.p_actor,user);
  assert.equal((await post({action:"limits",max_devices:999,max_courts:999,storage_limit_bytes:null})).status,400);
  assert.equal((await post({action:"create",name:"My club",slug:"my-club",owner_id:other})).status,200);
  assert.equal(calls[1].args.p_owner,user);
  account=null;assert.equal((await post({action:"create",name:"Club",slug:"club"})).status,401);
});
