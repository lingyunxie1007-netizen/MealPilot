import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 在真实 Chromium 里走完输入密钥、发消息、读流与人工确认，供应商由本机 fixture 代替。
test("窄屏浏览器流式聊天和确认按钮", {skip:!process.env.CHROME_PATH, timeout:45000}, async()=>{
  let confirms=0, selectedText="";
  const action={actionId:"one",kind:"auto-bind-coupons",status:"pending",expectedVersion:0,quoteId:null,payload:{arguments:{}}};
  const driver=`<script type="module">
  try {
    const el=id=>document.getElementById(id);
    const wait=async f=>{for(let i=0;i<250;i++){if(f())return;await new Promise(r=>setTimeout(r,20));}throw Error("等待界面超时")};
    document.querySelector("[data-prompt]").click();
    el("composer").requestSubmit(); await wait(()=>el("auth-dialog").open);
    el("access-key").value="local-test-only";el("auth-form").requestSubmit();
    await wait(()=>!el("auth-dialog").open);
    if(!el("prompt").value)throw Error("首次连接丢失消息");
    el("choose-store").click();
    Object.defineProperty(navigator,"geolocation",{configurable:true,value:{
      getCurrentPosition:(_ok,no)=>no({code:1})
    }});
    el("locate-store").click(); await wait(()=>el("store-feedback").textContent.includes("定位权限受限"));
    el("store-city").value="惠州";el("store-search").requestSubmit();
    await wait(()=>el("store-feedback").textContent.includes("已填写城市"));
    if(document.activeElement!==el("store-keyword"))throw Error("缺少地点时应聚焦地点输入框");
    el("store-city").value="上海";el("store-keyword").value="人民广场";el("store-search").requestSubmit();
    await wait(()=>el("store-results").querySelector("button"));
    el("store-results").querySelector("button").click();
    if(!el("store-label").textContent.includes("测试餐厅"))throw Error("门店选择丢失");
    el("composer").requestSubmit();
    await wait(()=>el("messages").textContent.includes("结果已核实"));
    if(!document.querySelector(".meal-card"))throw Error("缺少推荐卡");
    document.querySelector(".action-card .card-controls button").click();
    await wait(()=>!document.querySelector(".action-card .card-controls button"));
    if(document.documentElement.scrollWidth>innerWidth+1)throw Error("横向溢出");
    document.body.dataset.test="passed";
  } catch(e){document.body.dataset.test=String(e)}
  </script>`;
  const server=createServer(async(req,res)=>{
    const path=req.url||"/";
    if(["/","/app.js","/style.css","/cards.js","/location.js"].includes(path)){
      const file=path==="/"?"index.html":path.slice(1);
      const data=await readFile(new URL("../web/"+file,import.meta.url),"utf8");
      res.setHeader("Content-Type",path==="/"?"text/html; charset=utf-8":path.endsWith(".css")?"text/css":"text/javascript");
      return res.end(path==="/"?data.replace("</body>",driver+"</body>"):data);
    }
    if(req.headers.authorization!=="Bearer local-test-only"){res.writeHead(401);return res.end("{}");}
    if(path==="/conversations")return res.end(JSON.stringify({conversationId:"chat"}));
    if(path==="/stores/nearby")return res.end(JSON.stringify([{storeCode:"12345",storeName:"测试餐厅",businessStatus:true,distance:200}]));
    if(path.endsWith("/messages")){
      let body="";for await(const chunk of req)body+=chunk;
      selectedText=JSON.parse(body).text;
      return res.end(JSON.stringify({runId:"run"}));
    }
    if(path.endsWith("/events")){
      res.setHeader("Content-Type","text/event-stream");
      const events=[["text_delta",{delta:"正在查询"}],["draft_ready",{draftId:"d",version:1,data:{candidates:[],issues:[]}}],
        ["confirmation_required",action],["run_completed",{text:"结果已核实"}]] as const;
      return res.end(events.map(([type,data],i)=>"event: "+type+"\ndata: "+JSON.stringify({...data,seq:i+1})+"\n\n").join(""));
    }
    if(path.endsWith("/confirm")){confirms++;return res.end(JSON.stringify({...action,status:"succeeded"}));}
    res.writeHead(404);res.end();
  });
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  const address=server.address() as {port:number};
  const profile=await mkdtemp(join(tmpdir(),"mealpilot-ui-"));
  try{
    const {stdout}=await promisify(execFile)(process.env.CHROME_PATH!,["--headless","--disable-gpu","--disable-extensions","--no-first-run",
      "--window-size=390,844","--user-data-dir="+profile,"--virtual-time-budget=10000","--dump-dom","http://127.0.0.1:"+address.port],{timeout:30000,windowsHide:true});
    assert.match(stdout,/data-test="passed"/);
    assert.equal(confirms,1);
    assert.match(selectedText,/storeCode=12345/);
  } finally {server.close(); await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
