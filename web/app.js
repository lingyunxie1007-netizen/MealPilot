import { renderDraft, renderAction } from "./cards.js";
import { initLocation } from "./location.js";

const $ = (id) => document.getElementById(id);
const messages = $("messages"), prompt = $("prompt"), dialog = $("auth-dialog");
let key = sessionStorage.getItem("mealpilot.key") || "";
let conversation, draft, running, posting = false;
const status = (text) => { $("status").textContent = text; };
status(key ? "可以开始对话" : "待连接");
let selectedStore;
const resetLocation = initLocation({
  ensureKey() {
    if (key) return true;
    openSettings();
    return false;
  },
  search: args => api("/stores/nearby", {method:"POST",body:args}),
  select(store, beType) {
    selectedStore = store ? {store, beType} : undefined;
    draft = undefined;
    if (store && !prompt.value.trim() && messages.childElementCount)
      prompt.value = "请按刚才的用餐需求，在这家门店帮我搭配。";
    prompt.focus();
  }
});

async function request(path, options = {}) {
  const headers = { Authorization: "Bearer " + key, ...options.headers };
  if (options.body) headers["Content-Type"] = "application/json";
  const response = await fetch(path, {
    method: options.method || "GET", headers,
    body: options.body && JSON.stringify(options.body),
    cache: "no-store", signal: options.signal
  });
  if (!response.ok) {
    if (response.status === 401) status("访问密钥无效");
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || "服务返回 " + response.status);
  }
  return response;
}
async function api(path, options) { return (await request(path, options)).json(); }
function controls() {
  $("send").disabled = posting;
  $("new-chat").disabled = $("settings").disabled = Boolean(running || posting);
}
function scroll() { $("scroll-area").scrollTop = $("scroll-area").scrollHeight; }
function bubble(role, text) {
  $("welcome").hidden = true;
  const group = document.createElement("article");
  group.className = "message " + role;
  const content = document.createElement("div");
  content.className = "bubble";
  content.textContent = text;
  group.append(content);
  messages.append(group);
  scroll();
  return content;
}
function reset() {
  conversation = draft = undefined;
  selectedStore = undefined;
  resetLocation();
  messages.replaceChildren();
  $("welcome").hidden = false;
  $("conversation-title").textContent = "点餐对话";
  prompt.value = "";
  status(key ? "可以开始对话" : "待连接");
}
function openSettings() {
  $("access-key").value = key;
  $("auth-error").textContent = "";
  dialog.showModal();
}
$("settings").onclick = openSettings;
$("close-auth").onclick = () => dialog.close();
$("new-chat").onclick = () => { reset(); prompt.focus(); };
$("auth-form").onsubmit = async (event) => {
  event.preventDefault();
  const nextKey = $("access-key").value.trim();
  const previousKey = key;
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  key = nextKey;
  try {
    // 创建会话同时验证应用密钥，浏览器无需接触模型和麦当劳凭据。
    const result = await api("/conversations", {method:"POST"});
    if (previousKey !== key || !conversation) {
      const unsent = prompt.value;
      reset();
      prompt.value = unsent;
      conversation = result.conversationId;
    }
    sessionStorage.setItem("mealpilot.key", key);
    dialog.close();
    status("已连接");
    prompt.focus();
  } catch (error) {
    key = previousKey;
    $("auth-error").textContent = error.message;
  } finally { if (submit) submit.disabled = false; }
};
for (const button of document.querySelectorAll("[data-prompt]")) {
  button.onclick = () => { prompt.value = button.dataset.prompt; prompt.focus(); };
}
prompt.onkeydown = event => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    if (!posting) $("composer").requestSubmit();
  }
};

// fetch 可以携带 Authorization。按完整 SSE 帧处理，保留 UTF-8 跨分块字符。
async function readEvents(id, after, accept, signal) {
  const response = await request("/runs/"+encodeURIComponent(id)+"/events", {
    headers:{"Last-Event-ID":String(after),Accept:"text/event-stream"},signal
  });
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) throw new Error("事件连接提前结束");
      buffer += value;
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0,match.index);
        buffer = buffer.slice(match.index+match[0].length);
        const lines = frame.split(/\r?\n/);
        const type = lines.find(s=>s.startsWith("event:"))?.slice(6).trim();
        const data = lines.filter(s=>s.startsWith("data:")).map(s=>s.slice(5).trimStart()).join("\n");
        if (type && data && accept(type, JSON.parse(data))) return;
      }
    }
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
}
async function watch(runId, reply, signal) {
  let seq = 0;
  let partial = "";
  const accept = (type,data) => {
    if (data.seq <= seq) return false;
    seq = data.seq;
    if (type === "text_delta") {
      partial += data.delta ?? data.text ?? "";
      reply.textContent = partial;
    } else if (type === "draft_ready") {
      messages.append(renderDraft(data, id=>{
        draft = id;
        status("已选中搭配草稿");
        prompt.focus();
      }));
    } else if (type === "confirmation_required") {
      messages.append(renderAction(data,api));
    } else if (type === "run_completed" || type === "run_failed") {
      reply.textContent = data.text || data.message || partial || "处理完成";
      if(type === "run_failed") reply.classList.add("error");
      scroll();
      return true;
    }
    scroll();
    return false;
  };
  for (let attempt=0;;attempt++) {
    try { await readEvents(runId,seq,accept,signal); return; }
    catch(error) {
      if (signal.aborted || attempt===2) throw error;
      status("正在恢复连接…");
      await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));
    }
  }
}
$("composer").onsubmit = async event => {
  event.preventDefault();
  const text = prompt.value.trim();
  if (!text || posting) return;
  if (!key) { openSettings(); return; }
  posting = true;
  controls();
  try {
    conversation ??= (await api("/conversations",{method:"POST"})).conversationId;
    const chosen = selectedStore;
    // 模型只需要用户选定的餐厅与履约方式；查店所用的经纬度不进入对话。
    const message = chosen ? text + "\n所选门店：" + chosen.store.storeName
      + "（storeCode=" + chosen.store.storeCode + "，orderType=1，beType=" + chosen.beType
      + "，" + (chosen.beType===5 ? "得来速" : "到店自取") + "）。" : text;
    const {runId}=await api("/conversations/"+conversation+"/messages",{
      method:"POST",body:{clientMessageId:crypto.randomUUID(),text:message,draftId:draft}
    });
    $("conversation-title").textContent = "当前对话";
    bubble("user",chosen ? text + "\n📍 " + chosen.store.storeName : text);
    prompt.value = "";
    // 插话也有独立 runId。新事件流从插话开始，终态包含本轮完整答复。
    if (running) {
      running.controller.abort();
      if (!running.reply.textContent || running.reply.textContent==="正在处理…") running.reply.textContent="已接收追加要求";
    }
    const reply = bubble("assistant","正在处理…");
    const ticket = {controller:new AbortController(),reply};
    running = ticket;
    status("助手处理中");
    posting = false;
    controls();
    try { await watch(runId,reply,ticket.controller.signal); }
    catch(error) { if(!ticket.controller.signal.aborted) {reply.textContent = "读取回复失败："+error.message; reply.classList.add("error");} }
    finally { if(running===ticket){running=undefined;status("已连接");} }
  } catch(error) {
    posting = false;
    bubble("assistant","发送失败："+error.message).classList.add("error");
  } finally { controls(); }
};
