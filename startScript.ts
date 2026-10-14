import express from 'express'
import path from 'path'
import {randomUUID} from 'crypto'
import {createWriteStream} from 'fs'
import {mkdir,readFile,writeFile,rm} from 'fs/promises'
import {pipeline} from 'stream/promises'
import {Readable} from 'stream'
import QRCode from 'qrcode'
import pino from 'pino'
import {Boom} from '@hapi/boom'
import makeWASocket,{DisconnectReason,downloadMediaMessage,getContentType,makeCacheableSignalKeyStore,normalizeMessageContent,useMultiFileAuthState} from '@whiskeysockets/baileys'

type MediaType='imageMessage'|'videoMessage'|'audioMessage'|'documentMessage'|'stickerMessage'
interface Rule{enabled:boolean;folder:string}
interface ChatCfg{jid:string;label:string;enabled:boolean}
interface UserCfg{id:string;name:string;enabled:boolean;includeOwnMessages:boolean;listenAllConversations:boolean;downloadRoot:string;conversations:ChatCfg[];media:Record<MediaType,Rule>}
interface Cfg{users:UserCfg[]}
type Sock=ReturnType<typeof makeWASocket>
interface Runtime{sock?:Sock;status:'stopped'|'connecting'|'awaiting_qr'|'connected'|'disconnected'|'logged_out'|'error';qrDataUrl?:string;lastError?:string;generation:number;shouldStayConnected:boolean}

const root=process.cwd()
const dataDir=path.join(root,'data')
const authDir=path.join(dataDir,'auth')
const cfgPath=path.join(dataDir,'config.json')
const TEXT_DIR=path.join(dataDir,'texts')
const log=pino({level:'silent'})
const runtimes=new Map<string,Runtime>()
let cfg:Cfg={users:[]}

function mediaDefaults():Record<MediaType,Rule>{
  return{
    imageMessage:{enabled:true,folder:'images'},
    documentMessage:{enabled:true,folder:'documents'},
    videoMessage:{enabled:false,folder:'videos'},
    audioMessage:{enabled:false,folder:'audio'},
    stickerMessage:{enabled:false,folder:'stickers'}
  }
}

async function initStorage(){
  await mkdir(dataDir,{recursive:true})
  await mkdir(authDir,{recursive:true})

  try{
    const raw=await readFile(cfgPath,'utf8')
    const parsed=JSON.parse(raw)
    if(parsed&&typeof parsed==='object'&&Array.isArray(parsed.users))cfg={users:parsed.users}
    else if(Array.isArray(parsed))cfg={users:parsed}
    else cfg={users:[]}
  }catch{
    cfg={users:[]}
  }

  const defs=mediaDefaults()
  for(const u of cfg.users){
    u.enabled??=false
    u.includeOwnMessages??=false
    u.listenAllConversations??=false
    u.downloadRoot??=path.join('downloads',safeName(u.name||u.id))
    u.conversations??=[]
    u.media={...defs,...(u.media||{})}
    for(const t of Object.keys(defs) as MediaType[])u.media[t]={...defs[t],...(u.media[t]||{})}
  }

  await saveCfg()
}

async function saveCfg(){
  await writeFile(cfgPath,JSON.stringify(cfg,null,2),'utf8')
}

function userById(id:string){
  return cfg.users.find(u=>u.id===id)
}

function runtimeFor(id:string):Runtime{
  let rt=runtimes.get(id)
  if(!rt){
    rt={status:'stopped',generation:0,shouldStayConnected:false}
    runtimes.set(id,rt)
  }
  return rt
}

function safeName(v:string){
  return v.replace(/[<>:"/\\|?*\x00-\x1F]/g,'_').replace(/\.+$/g,'').trim().slice(0,180)
}

function stamp(){
  return new Date().toISOString().replace(/[:.]/g,'-')
}

function extFromMime(mime:string|null|undefined,type:MediaType){
  const m=mime?.split(';')[0]?.toLowerCase()
  const known:Record<string,string>={
    'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','video/mp4':'.mp4',
    'audio/ogg':'.ogg','audio/mpeg':'.mp3','audio/mp4':'.m4a','application/pdf':'.pdf',
    'application/msword':'.doc','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'.docx',
    'application/vnd.ms-excel':'.xls','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'.xlsx',
    'application/vnd.ms-powerpoint':'.ppt','application/vnd.openxmlformats-officedocument.presentationml.presentation':'.pptx',
    'text/plain':'.txt','text/csv':'.csv'
  }
  if(m&&known[m])return known[m]
  if(type==='imageMessage')return'.jpg'
  if(type==='videoMessage')return'.mp4'
  if(type==='audioMessage')return'.ogg'
  if(type==='stickerMessage')return'.webp'
  return'.bin'
}

async function rememberChat(uid:string,jid:string,label?:string){
  const u=userById(uid)
  if(!u)return

  const chat=u.conversations.find(c=>c.jid===jid)
  if(chat){
    if(label&&(!chat.label||chat.label===chat.jid)){
      chat.label=label
      await saveCfg()
    }
    return
  }

  u.conversations.push({jid,label:label||jid,enabled:false})
  await saveCfg()
}

async function discoverChat(uid:string,sock:Sock,jid:string,label?:string){
  const u=userById(uid)
  if(!u||u.conversations.some(c=>c.jid===jid))return

  let name=label||jid
  if(jid.endsWith('@g.us')){
    try{
      const meta=await sock.groupMetadata(jid)
      if(meta.subject)name=meta.subject
    }catch{}
  }
  await rememberChat(uid,jid,name)
}

async function chatMatches(sock:Sock,cfgJid:string,msg:any):Promise<boolean>{
  const jid=msg.key.remoteJid as string|undefined
  const alt=msg.key.remoteJidAlt as string|undefined
  if(!jid)return false
  if(cfgJid===jid||cfgJid===alt)return true

  try{
    if(cfgJid.endsWith('@s.whatsapp.net')){
      const lid=await sock.signalRepository.lidMapping.getLIDForPN(cfgJid)
      if(lid===jid)return true
    }
    if(cfgJid.endsWith('@lid')){
      const pn=await sock.signalRepository.lidMapping.getPNForLID(cfgJid)
      if(pn&&(pn===jid||pn===alt))return true
    }
    if(jid.endsWith('@lid')){
      const pn=await sock.signalRepository.lidMapping.getPNForLID(jid)
      if(pn===cfgJid)return true
    }
  }catch{}

  return false
}

function getText(msg:any){
  const m=normalizeMessageContent(msg.message)
  if(!m)return null
  return m.conversation
    ??m.extendedTextMessage?.text
    ??m.imageMessage?.caption
    ??m.videoMessage?.caption
    ??m.documentMessage?.caption
    ??null}

async function saveText(uid:string,sock:Sock,msg:any){
  const u=userById(uid)
  if(!u?.enabled||!msg.message)return
  const jid=msg.key.remoteJid as string|undefined
  if(!jid)return

  let chatJid=jid
  if(!u.listenAllConversations){
    chatJid=''
    for(const c of u.conversations){
      if(!c.enabled)continue

      if(await chatMatches(sock,c.jid,msg)){
        chatJid=c.jid
        break}}
    if(!chatJid)return}

  const text=getText(msg)
  if(!text)return
  const raw=msg.messageTimestamp
  const sec=Number(raw?.toString?.()??raw)||Math.floor(Date.now()/1000)
  const time=new Date(sec*1000).toISOString()
  const dir=path.join(TEXT_DIR,uid,safeName(chatJid))
  await mkdir(dir,{recursive:true})

  const id=safeName(msg.key.id||randomUUID())
  const data={
    id,direction:msg.key.fromMe?'sent':'received',
    conversationJid:chatJid,remoteJid:jid,
    remoteJidAlt:msg.key.remoteJidAlt??null,participant:msg.key.participant??null,
    name:msg.pushName??null,time,text}
  const file=`${time.replace(/[:.]/g,'-')}-${id}.json`
  await writeFile(
    path.join(dir,file),
    JSON.stringify(data,null,2),
    'utf8')
  console.log(`[${u.name}] text saved: ${text}`)}

async function handleMedia(uid:string,sock:Sock,msg:any){
  const u=userById(uid)
  if(!u||!u.enabled)return
  if(!u.includeOwnMessages&&msg.key.fromMe)return

  const jid=msg.key.remoteJid as string|undefined
  if(!jid)return

  if(!u.listenAllConversations){
    let allowed=false
    for(const c of u.conversations){
      if(!c.enabled)continue
      if(await chatMatches(sock,c.jid,msg)){
        allowed=true
        break
      }
    }
    if(!allowed)return
  }

  const content=normalizeMessageContent(msg.message)
  if(!content)return

  const rawType=getContentType(content)
  const supported:MediaType[]=['imageMessage','documentMessage','videoMessage','audioMessage','stickerMessage']
  if(!rawType||!supported.includes(rawType as MediaType))return

  const type=rawType as MediaType
  const rule=u.media[type]
  if(!rule?.enabled)return

  const media=(content as any)[type]
  if(!media)return

  const base=path.isAbsolute(u.downloadRoot)?u.downloadRoot:path.resolve(root,u.downloadRoot)
  const dir=path.join(base,rule.folder)
  await mkdir(dir,{recursive:true})

  let file:string
  if(type==='documentMessage'&&media.fileName)file=safeName(media.fileName)
  else{
    const ext=extFromMime(media.mimetype,type)
    const id=safeName(msg.key.id||randomUUID())
    file=`${stamp()}-${type.replace('Message','')}-${id}${ext}`
  }

  if(type==='documentMessage')file=`${stamp()}-${safeName(msg.key.id||randomUUID())}-${file}`
  const out=path.join(dir,file)

  try{
    const stream=await downloadMediaMessage(msg,'stream',{},{logger:log,reuploadRequest:sock.updateMediaMessage})
    await pipeline(stream as Readable,createWriteStream(out))
    console.log(`[${u.name}] saved ${file}`)
  }catch(err){
    console.error(`[${u.name}] download failed:`,err)
  }
}

async function connectUser(uid:string){
  const u=userById(uid)
  if(!u)throw new Error('Unknown user')

  const rt=runtimeFor(uid)
  if(rt.sock&&(rt.status==='connected'||rt.status==='connecting'||rt.status==='awaiting_qr'))return

  rt.shouldStayConnected=true
  rt.lastError=undefined
  const gen=++rt.generation
  rt.status='connecting'

  const authPath=path.join(authDir,uid)
  const{state,saveCreds}=await useMultiFileAuthState(authPath)
  const sock=makeWASocket({
    logger:log,
    auth:{creds:state.creds,keys:makeCacheableSignalKeyStore(state.keys,log)}
  })
  rt.sock=sock

  sock.ev.on('creds.update',saveCreds)

  sock.ev.on('messaging-history.set',async({chats})=>{
    for(const chat of chats){
      if(!chat.id)continue
      await rememberChat(uid,chat.id,(chat as any).name||chat.id)
    }
  })

  sock.ev.on('connection.update',async up=>{
    if(gen!==rt.generation)return
    const{connection,lastDisconnect,qr}=up

    if(qr){
      rt.status='awaiting_qr'
      rt.qrDataUrl=await QRCode.toDataURL(qr,{width:360,margin:2})
    }

    if(connection==='open'){
      rt.status='connected'
      rt.qrDataUrl=undefined
      console.log(`[${u.name}] connected`)
    }

    if(connection==='close'){
      rt.sock=undefined
      const code=(lastDisconnect?.error as Boom)?.output?.statusCode
      if(code===DisconnectReason.loggedOut){
        rt.status='logged_out'
        rt.qrDataUrl=undefined
        return
      }

      rt.status='disconnected'
      if(rt.shouldStayConnected&&gen===rt.generation){
        setTimeout(()=>{
          connectUser(uid).catch(err=>{
            rt.status='error'
            rt.lastError=String(err)
          })
        },1500)
      }
    }
  })

  sock.ev.on('messages.upsert',async({messages,type})=>{
    for(const msg of messages){
      if(!msg.message)continue
      const jid=msg.key.remoteJid
      console.log(`[${u.name}] incoming JID:`,jid)
      if(jid)await discoverChat(uid,sock,jid,msg.pushName||jid)
      if(type!=='notify')continue
      await saveText(uid,sock,msg)
      await handleMedia(uid,sock,msg)
    }})}

async function stopUser(uid:string){
  const rt=runtimeFor(uid)
  rt.shouldStayConnected=false
  rt.generation++
  const sock=rt.sock
  rt.sock=undefined
  rt.qrDataUrl=undefined
  rt.status='stopped'
  if(sock){
    try{await sock.end(undefined)}catch{}
  }
}

async function resetUserAuth(uid:string){
  const rt=runtimeFor(uid)
  const sock=rt.sock
  rt.shouldStayConnected=false
  rt.generation++
  rt.sock=undefined
  rt.qrDataUrl=undefined

  if(sock){
    try{await sock.logout()}
    catch{try{await sock.end(undefined)}catch{}}
  }

  await rm(path.join(authDir,uid),{recursive:true,force:true})
  rt.status='stopped'
  await connectUser(uid)
}

async function deleteUser(uid:string){
  if(!userById(uid))throw new Error('User not found')
  await stopUser(uid)
  await rm(path.join(authDir,uid),{recursive:true,force:true})
  cfg.users=cfg.users.filter(u=>u.id!==uid)
  runtimes.delete(uid)
  await saveCfg()
}

async function clearChats(uid:string){
  const u=userById(uid)
  if(!u)throw new Error('User not found')
  u.conversations=[]
  await saveCfg()
}

const app=express()
app.use(express.json({limit:'1mb'}))

app.get('/api/state',(_req,res)=>{
  res.json({users:cfg.users.map(u=>{
    const rt=runtimeFor(u.id)
    return{...u,runtime:{status:rt.status,qrDataUrl:rt.qrDataUrl,lastError:rt.lastError}}
  })})
})

app.post('/api/users',async(req,res)=>{
  const name=String(req.body?.name||'').trim()
  if(!name){
    res.status(400).json({error:'Name is required'})
    return
  }

  const u:UserCfg={
    id:randomUUID(),name,enabled:false,includeOwnMessages:false,listenAllConversations:false,
    downloadRoot:path.join('downloads',safeName(name)),conversations:[],media:mediaDefaults()
  }
  cfg.users.push(u)
  await saveCfg()
  res.json(u)
})

app.delete('/api/users/:id',async(req,res)=>{
  try{
    await deleteUser(req.params.id)
    res.json({ok:true})
  }catch(err){
    res.status(500).json({error:String(err)})
  }
})

app.delete('/api/users/:id/conversations',async(req,res)=>{
  try{
    await clearChats(req.params.id)
    res.json({ok:true})
  }catch(err){
    res.status(500).json({error:String(err)})
  }
})

app.put('/api/users/:id',async(req,res)=>{
  const u=userById(req.params.id)
  if(!u){
    res.status(404).json({error:'User not found'})
    return
  }

  const b=req.body as Partial<UserCfg>
  if(typeof b.name==='string')u.name=b.name.trim()
  if(typeof b.enabled==='boolean')u.enabled=b.enabled
  if(typeof b.includeOwnMessages==='boolean')u.includeOwnMessages=b.includeOwnMessages
  if(typeof b.listenAllConversations==='boolean')u.listenAllConversations=b.listenAllConversations
  if(typeof b.downloadRoot==='string')u.downloadRoot=b.downloadRoot.trim()

  if(Array.isArray(b.conversations)){
    u.conversations=b.conversations
      .filter(c=>c&&typeof c.jid==='string')
      .map(c=>({jid:c.jid.trim(),label:(c.label||c.jid).trim(),enabled:Boolean(c.enabled)}))
  }

  if(b.media){
    for(const t of Object.keys(mediaDefaults()) as MediaType[]){
      const r=b.media[t]
      if(!r)continue
      u.media[t]={enabled:Boolean(r.enabled),folder:String(r.folder||u.media[t].folder)}
    }
  }

  await saveCfg()
  res.json({ok:true})
})

app.post('/api/users/:id/connect',async(req,res)=>{
  try{
    await connectUser(req.params.id)
    res.json({ok:true})
  }catch(err){
    res.status(500).json({error:String(err)})
  }
})

app.post('/api/users/:id/stop',async(req,res)=>{
  await stopUser(req.params.id)
  res.json({ok:true})
})

app.post('/api/users/:id/reset',async(req,res)=>{
  try{
    await resetUserAuth(req.params.id)
    res.json({ok:true})
  }catch(err){
    res.status(500).json({error:String(err)})
  }
})

app.post('/api/run',async(_req,res)=>{
  for(const u of cfg.users){
    if(u.enabled){
      connectUser(u.id).catch(err=>{
        const rt=runtimeFor(u.id)
        rt.status='error'
        rt.lastError=String(err)
      })
    }else await stopUser(u.id)
  }
  res.json({ok:true})
})

const html=String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>WhatsApp Listener</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:Arial,sans-serif;background:#111;color:#eee}
header{display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid #333}
button{cursor:pointer;padding:9px 14px;border:0;border-radius:6px}
button.primary{background:#25d366;color:#07180d;font-weight:bold}
button.danger{background:#8b2525;color:white}
input[type=text]{width:100%;padding:8px;border-radius:5px;border:1px solid #444;background:#1d1d1d;color:white}
.layout{display:grid;grid-template-columns:280px 1fr;min-height:calc(100vh - 70px)}
aside{border-right:1px solid #333;padding:18px}
main{padding:24px;max-width:1000px}
.user{border:1px solid #333;border-radius:7px;padding:10px;margin-bottom:8px;cursor:pointer}
.user.selected{border-color:#25d366}
.row{display:flex;gap:10px;align-items:center;margin-bottom:12px}
.grow{flex:1}
.card{border:1px solid #333;border-radius:8px;padding:16px;margin:14px 0}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;border-bottom:1px solid #333;padding:8px}
code{color:#97d7ff}
.status{font-weight:bold}
#qrImage{max-width:360px;background:white;padding:6px;display:none}
.muted{color:#999;font-size:13px}
.media-grid{display:grid;grid-template-columns:170px 120px 1fr;gap:8px;align-items:center}
</style>
</head>
<body>
<header>
  <strong>WhatsApp Listener</strong>
  <div><button onclick="refreshAll()">Refresh</button> <button class="primary" onclick="runListeners()">Run listeners</button></div>
</header>
<div class="layout">
  <aside>
    <div class="row"><input id="newUserName" class="grow" type="text" placeholder="New user name"><button class="primary" onclick="createUser()">+</button></div>
    <div id="users"></div>
  </aside>
  <main id="main">Select or create a user.</main>
</div>
<script>
let state={users:[]}
let selectedId=null

function esc(v){
  return String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;')
}

async function api(url,opt={}){
  if(opt.body&&typeof opt.body!=='string'){
    opt.body=JSON.stringify(opt.body)
    opt.headers={...(opt.headers||{}),'Content-Type':'application/json'}
  }
  const res=await fetch(url,opt)
  const body=await res.json()
  if(!res.ok)throw new Error(body.error||'Request failed')
  return body
}

async function refreshAll(){
  state=await api('/api/state')
  if(selectedId&&!state.users.some(u=>u.id===selectedId))selectedId=null
  if(!selectedId&&state.users.length)selectedId=state.users[0].id
  renderUsers()
  renderEditor()
}

function renderUsers(){
  const box=document.getElementById('users')
  box.innerHTML=''
  for(const u of state.users){
    const el=document.createElement('div')
    el.className='user'+(u.id===selectedId?' selected':'')
    el.innerHTML='<strong>'+esc(u.name)+'</strong><br><span class="muted">'+esc(u.runtime.status)+'</span>'
    el.addEventListener('click',()=>selectUser(u.id))
    box.appendChild(el)
  }
}

function selectUser(id){
  selectedId=id
  renderUsers()
  renderEditor()
}

function selectedUser(){
  return state.users.find(u=>u.id===selectedId)
}

function filterConversations(){
  const input=document.getElementById('conversationSearch')
  if(!input)return
  const q=input.value.toLowerCase().replace(/[^0-9a-z+]/g,'')
  for(const row of document.querySelectorAll('.conversation-row')){
    const s=row.dataset.search||''
    row.style.display=!q||s.includes(q)?'':'none'
  }
}

function renderEditor(){
  const main=document.getElementById('main')
  const u=selectedUser()
  if(!u){
    main.innerHTML='Select or create a user.'
    return
  }

  const names={imageMessage:'Images',documentMessage:'Documents',videoMessage:'Videos',audioMessage:'Audio',stickerMessage:'Stickers'}
  const media=Object.keys(names).map(type=>{
    const r=u.media[type]
    return '<div>'+esc(names[type])+'</div>'+
      '<div><input type="checkbox" id="media_'+type+'_enabled" '+(r.enabled?'checked':'')+'> Download</div>'+
      '<div><input type="text" id="media_'+type+'_folder" value="'+esc(r.folder)+'"></div>'
  }).join('')

  const chats=u.conversations.map((c,i)=>{
    const search=esc((c.jid+' '+c.label).toLowerCase().replace(/[^0-9a-z+]/g,''))
    return '<tr class="conversation-row" data-search="'+search+'">'+
      '<td><input class="conversation-enabled" data-index="'+i+'" type="checkbox" '+(c.enabled?'checked':'')+'></td>'+
      '<td><input class="conversation-label" data-index="'+i+'" type="text" value="'+esc(c.label)+'"></td>'+
      '<td><code>'+esc(c.jid)+'</code></td>'+
      '<td><button onclick="removeConversation('+i+')">Remove</button></td></tr>'
  }).join('')

  main.innerHTML=
    '<h2>'+esc(u.name)+'</h2>'+
    '<div class="card">'+
      '<div class="row"><strong>Status:</strong> <span class="status" id="runtimeStatus">'+esc(u.runtime.status)+'</span></div>'+
      '<div class="row"><button class="primary" onclick="connectUser()">Connect / show QR</button><button onclick="stopUser()">Stop</button><button class="danger" onclick="resetUser()">Reset auth + new QR</button><button class="danger" onclick="deleteUser()">Remove user</button></div>'+
      '<img id="qrImage"><div class="muted">Reset auth creates a fresh linked-device session.</div>'+
    '</div>'+
    '<div class="card">'+
      '<h3>User settings</h3>'+
      '<label>Name</label><input id="name" type="text" value="'+esc(u.name)+'"><br><br>'+
      '<label><input id="enabled" type="checkbox" '+(u.enabled?'checked':'')+'> Process this user when Run listeners is pressed</label><br><br>'+
      '<label><input id="includeOwnMessages" type="checkbox" '+(u.includeOwnMessages?'checked':'')+'> Include messages sent by this account</label><br><br>'+
      '<label><input id="listenAllConversations" type="checkbox" '+(u.listenAllConversations?'checked':'')+'> Listen to every conversation</label><br><br>'+
      '<label>Download root</label><input id="downloadRoot" type="text" value="'+esc(u.downloadRoot)+'">'+
    '</div>'+
    '<div class="card"><h3>Media rules</h3><div class="media-grid"><strong>Type</strong><strong>Enabled</strong><strong>Subfolder</strong>'+media+'</div></div>'+
    '<div class="card">'+
      '<div class="row"><h3 class="grow">Conversations</h3><button onclick="addConversation()">Add manually</button><button onclick="refreshAll()">Refresh discovered chats</button><button class="danger" onclick="clearConversations()">Clear found chats</button></div>'+
      '<div class="muted">When "Listen to every conversation" is off, only checked JIDs are downloaded.</div><br>'+
      '<input id="conversationSearch" type="text" placeholder="Search by phone number..." oninput="filterConversations()"><br><br>'+
      '<table><thead><tr><th>Listen</th><th>Name</th><th>JID</th><th></th></tr></thead><tbody>'+chats+'</tbody></table>'+
    '</div>'+
    '<button class="primary" onclick="saveUser()">Save settings</button>'

  updateRuntimeDisplay()
}

function updateRuntimeDisplay(){
  const u=selectedUser()
  if(!u)return
  const status=document.getElementById('runtimeStatus')
  if(status)status.textContent=u.runtime.status
  const qr=document.getElementById('qrImage')
  if(!qr)return
  if(u.runtime.qrDataUrl){
    qr.src=u.runtime.qrDataUrl
    qr.style.display='block'
  }else qr.style.display='none'
}

async function pollRuntime(){
  try{
    const latest=await api('/api/state')
    for(const u of latest.users){
      const local=state.users.find(x=>x.id===u.id)
      if(local)local.runtime=u.runtime
    }
    renderUsers()
    updateRuntimeDisplay()
  }catch{}
}

async function createUser(){
  const input=document.getElementById('newUserName')
  const name=input.value.trim()
  if(!name){
    alert('Enter a user name first.')
    return
  }

  try{
    const u=await api('/api/users',{method:'POST',body:{name}})
    selectedId=u.id
    input.value=''
    await refreshAll()
  }catch(err){
    console.error(err)
    alert('Failed to create user: '+err.message)
  }
}

function collectConversations(u){
  return u.conversations.map((c,i)=>{
    const enabled=document.querySelector('.conversation-enabled[data-index="'+i+'"]')
    const label=document.querySelector('.conversation-label[data-index="'+i+'"]')
    return{jid:c.jid,label:label?label.value:c.label,enabled:enabled?enabled.checked:false}
  })
}

async function saveUser(){
  const u=selectedUser()
  if(!u)return

  const media={}
  for(const type of['imageMessage','documentMessage','videoMessage','audioMessage','stickerMessage']){
    media[type]={
      enabled:document.getElementById('media_'+type+'_enabled').checked,
      folder:document.getElementById('media_'+type+'_folder').value
    }
  }

  await api('/api/users/'+u.id,{
    method:'PUT',
    body:{
      name:document.getElementById('name').value,
      enabled:document.getElementById('enabled').checked,
      includeOwnMessages:document.getElementById('includeOwnMessages').checked,
      listenAllConversations:document.getElementById('listenAllConversations').checked,
      downloadRoot:document.getElementById('downloadRoot').value,
      conversations:collectConversations(u),media
    }
  })
  await refreshAll()
}

async function connectUser(){
  const u=selectedUser()
  if(!u)return
  await api('/api/users/'+u.id+'/connect',{method:'POST'})
}

async function stopUser(){
  const u=selectedUser()
  if(!u)return
  await api('/api/users/'+u.id+'/stop',{method:'POST'})
  await refreshAll()
}

async function deleteUser(){
  const u=selectedUser()
  if(!u)return
  if(!confirm('Remove "'+u.name+'" and delete its saved WhatsApp authentication session? Downloaded files will be kept.'))return

  try{
    await api('/api/users/'+u.id,{method:'DELETE'})
    selectedId=null
    await refreshAll()
  }catch(err){
    console.error(err)
    alert('Failed to remove user: '+err.message)
  }
}

async function clearConversations(){
  const u=selectedUser()
  if(!u)return
  if(!confirm('Remove all discovered conversations for "'+u.name+'"? They may be discovered again as messages arrive.'))return

  try{
    await api('/api/users/'+u.id+'/conversations',{method:'DELETE'})
    await refreshAll()
  }catch(err){
    console.error(err)
    alert('Failed to clear conversations: '+err.message)
  }
}

async function resetUser(){
  const u=selectedUser()
  if(!u||!confirm('Remove this saved Baileys session and create a new QR?'))return
  await api('/api/users/'+u.id+'/reset',{method:'POST'})
}

async function runListeners(){
  if(selectedUser())await saveUser()
  await api('/api/run',{method:'POST'})
  await refreshAll()
}

function addConversation(){
  const u=selectedUser()
  if(!u)return
  const jid=prompt('Conversation JID')
  if(!jid)return
  const label=prompt('Display name',jid)||jid
  u.conversations.push({jid:jid.trim(),label:label.trim(),enabled:true})
  renderEditor()
}

function removeConversation(i){
  const u=selectedUser()
  if(!u)return
  u.conversations.splice(i,1)
  renderEditor()
}

refreshAll()
setInterval(pollRuntime,1200)
</script>
</body>
</html>`

app.get('/',(_req,res)=>res.type('html').send(html))

async function main(){
  await initStorage()
  const port=3000
  app.listen(port,()=>console.log(`Control panel: http://localhost:${port}`))
}

main().catch(err=>{
  console.error(err)
  process.exit(1)
})
