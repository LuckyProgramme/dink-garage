import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("DinkVision branding preserves enrolled device identities and updates new device defaults",async()=>{
  const db=new PGlite();
  try {
    await db.exec(`create table browser_devices (
      id text primary key, enrollment_hash text,
      organization text not null default 'Wrenlabs Pickleball Camera'
        constraint browser_devices_organization_check check(organization='Wrenlabs Pickleball Camera')
    );insert into browser_devices(id,enrollment_hash) values('existing-device','existing-enrollment');`);
    await db.exec(await readFile("supabase/migrations/202610130035_dinkvision_branding.sql","utf8"));
    assert.deepEqual((await db.query("select * from browser_devices")).rows,[{
      id:"existing-device",enrollment_hash:"existing-enrollment",organization:"DinkVision",
    }]);
    await db.exec("insert into browser_devices(id) values('new-device')");
    assert.equal((await db.query<{organization:string}>("select organization from browser_devices where id='new-device'")).rows[0].organization,"DinkVision");
  } finally {await db.close();}
});
