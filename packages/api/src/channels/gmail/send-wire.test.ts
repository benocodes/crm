import { expect,it } from 'vitest'
import type { ChannelPort } from '../port.js'
import { GmailChannel } from './channel.js'
import { HttpGmailClient } from './client.js'
import { outboundMime,type OutboundPost } from './send-mime.js'
import { decodeMimeWords } from './mime.js'

const post:OutboundPost={from:'owner@example.test',to:['a@example.test'],cc:['b@example.test'],bcc:['c@example.test'],subject:'こんにちは 世界',text:'hé\r\n世界',client_ref:'fixed@example.test',provider_thread_id:null,provider_anchor_id:null}
it('new-send MIME pins explicit recipients/From/fixed Message-ID, Unicode and exact text, with no threading',()=>{
  const raw=outboundMime(post)
  for(const h of ['From: owner@example.test','To: a@example.test','Cc: b@example.test','Bcc: c@example.test','Message-ID: <fixed@example.test>','Content-Type: text/plain; charset=utf-8','Content-Transfer-Encoding: base64'])expect(raw).toContain(h+'\r\n')
  const headers=raw.split('\r\n\r\n')[0]!.replaceAll('\r\n ',' ')
  const subject=/Subject: (.*)/.exec(headers)![1]!
  expect(decodeMimeWords(subject)).toBe(post.subject)
  const encoded=raw.split('\r\n\r\n')[1]!.replaceAll('\r\n','')
  expect(new TextDecoder().decode(Uint8Array.from(atob(encoded),c=>c.charCodeAt(0)))).toBe(post.text)
  expect(raw).not.toContain('In-Reply-To:');expect(raw).not.toContain('References:')
  expect(raw.split('\r\n').every(line=>line.length<=998)).toBe(true)
})
it('reply MIME applies Re once and bounded safe References; header injection fails closed',()=>{
  const raw=outboundMime({...post,subject:'Re: hello',provider_thread_id:'thread',provider_anchor_id:'anchor',in_reply_to:'anchor@example.test',references:['old@example.test','bad\r\nBcc:x','anchor@example.test']})
  expect(raw).toContain('Subject: Re: hello\r\n');expect(raw).toContain('In-Reply-To: <anchor@example.test>\r\n');expect(raw).toContain('References: <old@example.test> <anchor@example.test>\r\n')
  expect(()=>outboundMime({...post,from:'bad\r\nBcc:x'})).toThrow()
})
it('actual HTTP wire uses base64url raw and selected metadata headers, sharing the attempt signal',async()=>{
  const calls:Array<{url:URL,init:RequestInit}>=[]
  const signal=new AbortController().signal
  const client=new HttpGmailClient({accessToken:async()=>'token',signal,fetch:async(input,init)=>{
    calls.push({url:new URL(String(input)),init:init!})
    return Response.json({id:'provider-id',threadId:'provider-thread',labelIds:['SENT'],payload:{headers:[{name:'Message-ID',value:'<fixed@example.test>'}]}})
  }})
  const raw=outboundMime(post)
  expect(await client.sendMessage(raw)).toMatchObject({id:'provider-id',threadId:'provider-thread'})
  await client.getMessageMetadata('provider-id')
  const payload=JSON.parse(String(calls[0]!.init.body))
  expect(payload.threadId).toBeUndefined();expect(payload.raw).toMatch(/^[A-Za-z0-9_-]+$/)
  expect(new TextDecoder().decode(Uint8Array.from(atob(payload.raw.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0)))).toBe(raw)
  expect(calls[1]!.url.searchParams.get('format')).toBe('metadata')
  expect(calls[1]!.url.searchParams.getAll('metadataHeaders')).toEqual(['Message-ID','References','Subject'])
  expect(calls.map(c=>c.init.signal)).toEqual([signal,signal])
})
it('late access-token resolution cannot initiate a POST after the signal expires',async()=>{
  const ac=new AbortController();let release!:(token:string)=>void;let calls=0
  const client=new HttpGmailClient({signal:ac.signal,accessToken:()=>new Promise(r=>{release=r}),fetch:async()=>{calls++;return Response.json({id:'p',threadId:'t'})}})
  const pending=client.sendMessage('mime');await Promise.resolve();ac.abort();release('token')
  await expect(pending).rejects.toBeDefined();expect(calls).toBe(0)
})

it('reply HTTP raw uses only the pinned provider anchor, decoded subject and bounded threading headers',async()=>{
  const calls:Array<{url:URL,init:RequestInit}>=[];const signal=new AbortController().signal
  const client=new HttpGmailClient({accessToken:async()=>'fake-token',signal,fetch:async(input,init)=>{
    const url=new URL(String(input));calls.push({url,init:init!})
    if(init?.method==='GET')return Response.json({id:'pinned-anchor',threadId:'pinned-thread',payload:{headers:[{name:'Message-ID',value:'<anchor@example.test>'},{name:'Subject',value:'=?UTF-8?B?SGVsbG8g5LiW55WM?='},{name:'References',value:'<older@example.test>'}]}})
    return Response.json({id:'provider-sent',threadId:'pinned-thread'})
  }})
  const channel:ChannelPort=new GmailChannel(client)
  await channel.postToThread!({...post,provider_anchor_id:'pinned-anchor',provider_thread_id:'pinned-thread',anchor_external_id:'anchor@example.test'},signal)
  expect(calls[0]!.url.pathname).toMatch(/messages\/pinned-anchor$/)
  const payload=JSON.parse(String(calls[1]!.init.body));expect(payload.threadId).toBe('pinned-thread')
  const mime=Buffer.from(payload.raw,'base64url').toString('utf8')
  expect(decodeMimeWords(/Subject: (.*)/.exec(mime)![1]!)).toBe('Re: Hello 世界')
  expect(mime).toContain('In-Reply-To: <anchor@example.test>');expect(mime).toContain('References: <older@example.test> <anchor@example.test>')
  expect(calls.every(c=>c.init.signal===signal)).toBe(true)
})
it('aborted anchor metadata that ignores cancellation cannot initiate a later POST',async()=>{
  const ac=new AbortController();let posts=0
  const client=new HttpGmailClient({accessToken:async()=>'fake-token',signal:ac.signal,fetch:async(_input,init)=>{
    if(init?.method==='POST'){posts++;return Response.json({id:'sent',threadId:'thread'})}
    ac.abort();return Response.json({id:'anchor',threadId:'thread',payload:{headers:[{name:'Message-ID',value:'<anchor@example.test>'}]}})
  }})
  await expect(new GmailChannel(client).postToThread({...post,provider_anchor_id:'anchor',provider_thread_id:'thread',anchor_external_id:'anchor@example.test'},ac.signal)).rejects.toBeDefined()
  expect(posts).toBe(0)
})

it('bounded References always retains the immediate anchor even when an earlier reference repeats it',()=>{
  const raw=outboundMime({...post,provider_thread_id:'t',provider_anchor_id:'a',in_reply_to:'anchor@example.test',references:['anchor@example.test',...Array.from({length:25},(_,i)=>`old${i}@example.test`)]})
  const unfolded=raw.replace(/\r\n[ \t]+/g,' ')
  const refs=/References: (.*)/.exec(unfolded)![1]!.split(' ')
  expect(refs).toHaveLength(20);expect(refs.at(-1)).toBe('<anchor@example.test>')
})
