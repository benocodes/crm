import type { OutboundPost } from '../port.js'
export type { OutboundPost } from '../port.js'
const base64 = (value:string) => btoa(Array.from(new TextEncoder().encode(value),b=>String.fromCharCode(b)).join(''))
const safe = (s:string) => {if(/[\x00-\x1f\x7f]/.test(s))throw new Error('unsafe outbound header');return s}
export const validOutboundId = (s:string):boolean => /^[\x21-\x7e]+@[\x21-\x7e]+$/.test(s)&&!/[<>()[\]\\",;:]/.test(s)&&s.length<=300
function subjectHeader(s:string):string {
  safe(s)
  if(/^[\x20-\x7e]{1,70}$/.test(s))return s
  const chunks:string[]=[];let chunk=''
  for(const c of s){if(new TextEncoder().encode(chunk+c).length>42){chunks.push(chunk);chunk=''}chunk+=c}
  if(chunk)chunks.push(chunk)
  return chunks.map(c=>`=?UTF-8?B?${base64(c)}?=`).join('\r\n ')
}
export function outboundMime(p:OutboundPost):string {
  const fields=[`From: ${safe(p.from)}`]
  for(const [name,values] of [['To',p.to],['Cc',p.cc],['Bcc',p.bcc]] as const)if(values.length)fields.push(`${name}: ${values.map(safe).join(',\r\n ')}`)
  if(!validOutboundId(p.client_ref))throw new Error('unsafe outbound identifier')
  const reply=p.provider_anchor_id!==null
  fields.push(`Subject: ${subjectHeader(reply?`Re: ${p.subject.replace(/^(?:re:\s*)+/i,'')}`:p.subject)}`,`Message-ID: <${p.client_ref}>`)
  if(reply){
    if(!p.in_reply_to||!validOutboundId(p.in_reply_to))throw new Error('unsafe outbound anchor')
    fields.push(`In-Reply-To: <${p.in_reply_to}>`)
    const refs=[...new Set((p.references??[]).filter(s=>validOutboundId(s)&&s!==p.in_reply_to)),p.in_reply_to].slice(-20)
    fields.push(`References: ${refs.map(s=>`<${s}>`).join(' ')}`.replace(/ (?!<[^>]*>$)(?=<)/g,' '))
    // Fold between complete tokens, never inside an id.
    const last=fields.pop()!;let line='';const lines:string[]=[]
    for(const token of last.split(' ')){if(line.length+token.length+1>78&&line){lines.push(line);line=' '+token}else line+=(line?' ':'')+token}lines.push(line);fields.push(lines.join('\r\n'))
  }
  fields.push('MIME-Version: 1.0','Content-Type: text/plain; charset=utf-8','Content-Transfer-Encoding: base64')
  const content=base64(p.text).match(/.{1,76}/g)?.join('\r\n')??''
  return fields.join('\r\n')+'\r\n\r\n'+content+'\r\n'
}
