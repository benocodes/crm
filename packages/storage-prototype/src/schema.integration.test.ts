import { expect, test } from 'vitest'
import { createOwnerTestDb } from '@vault/db/test'
import { sql } from 'kysely'
import { Miniflare } from 'miniflare'
test('Postgres machinery exists with forced RLS',async()=> {
 const db=createOwnerTestDb()
 try { const r=await sql<{relname:string;relrowsecurity:boolean;relforcerowsecurity:boolean}>`select c.relname,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='storage_prototype' and c.relkind='r'`.execute(db)
 expect(r.rows.map(r=>r.relname).sort()).toEqual(['operations','rows'])
 expect(r.rows.every(r=>r.relrowsecurity&&r.relforcerowsecurity)).toBe(true)
 }finally{await db.destroy()}
})
test('D1 fixture machinery exists',async()=> {
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-07-30',d1Databases:{DB:'01900000-0000-7000-8000-000000000011'}})
 try{const db=await mf.getD1Database('DB');const r=await db.prepare("select name from sqlite_master where type='table' and name like 'prototype_%' order by name").all();expect(r.results.map(r=>r.name)).toEqual(['prototype_operations','prototype_rows'])}finally{await mf.dispose()}
})
