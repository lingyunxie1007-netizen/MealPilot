const actions = {
  "create-order":"提交餐饮订单", "cancel-order":"取消餐饮订单", "auto-bind-coupons":"领取全部当前可领券",
  "mall-create-order":"提交商城订单", "party-order-create":"提交活动预约", "draw-lottery":"参与抽奖",
  "delivery-create-address":"保存配送地址"
};
const statuses = {pending:"等待确认",submitting:"正在提交",succeeded:"已完成",failed:"执行失败",unknown:"结果待核对"};
const mode = {1:"到店取餐",2:"麦乐送",5:"得来速",6:"企业团餐"};
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = String(text);
  return n;
}
const money = cents => Number.isSafeInteger(cents) ? "¥"+(cents/100).toFixed(2) : "价格待核实";
function details(title,value) {
  const d=el("details","card-detail");
  d.append(el("summary","",title),el("pre","",JSON.stringify(value,null,2))); return d;
}
function button(label,fn) {
  const b=el("button","card-button",label); b.type="button"; b.addEventListener("click",fn); return b;
}
function describe(ctx={}) {
  return [ctx.storeCode && "门店 "+ctx.storeCode,mode[ctx.beType],ctx.reservationDate].filter(Boolean).join(" · ");
}
export function renderDraft(event,onSelect) {
  const draft=event.draftId ? event : event.data;
  const card=el("article","meal-card");
  const data=draft.data??{};
  card.append(el("h3","card-heading","餐单草稿 · 第 "+draft.version+" 版"),
    el("p","card-context",describe(data.context)||"标准餐品营养"));
  for (const c of data.candidates??[]) {
    const row=el("section","candidate");
    const names=c.names.map((n,i)=>n+(c.items[i]?.quantity>1?" × "+c.items[i].quantity:""));
    row.append(el("h4","",names.join(" + ")),el("strong","card-price",money(c.priceCents)));
    const n=c.nutrition??{};
    row.append(el("p","candidate-metrics",[
      n.energyKcal==null?"热量待核实":n.energyKcal+" 千卡",
      n.protein==null?"蛋白质待核实":"蛋白质 "+n.protein+" 克"
    ].join(" · ")));
    if(c.quote?.deliveryPrice!=null) row.append(el("p","card-context","其中配送费 "+money(c.quote.deliveryPrice)));
    row.append(details("查看营养与规格依据",{营养:n,来源:c.source,规格核对:c.evidence,餐品详情:c.details}));
    card.append(row);
  }
  if (!data.candidates?.length) card.append(el("p","card-status","当前条件下没有可展示的候选"));
  for(const issue of data.issues??[]) card.append(el("p","card-issues",issue));
  if(onSelect && draft.draftId) card.append(button("选中这份草稿",()=>onSelect(draft.draftId)));
  return card;
}
function payment(value) {
  try {
    const url=new URL(value);
    if(url.protocol!=="https:" || url.username || url.password || url.port || !/(^|\.)(mcdchina\.net|mcd\.cn|mcdonalds\.com\.cn)$/i.test(url.hostname)) return;
    const a=el("a","card-button","打开麦当劳支付页"); a.href=url.href; a.target="_blank"; a.rel="noopener noreferrer"; return a;
  } catch { return; }
}
export function renderAction(event,api) {
  let action=event.actionId ? event : event.data;
  const card=el("article","action-card");
  function paint(forceRefresh=false,message="") {
    const payload=action.payload??{}, args=payload.arguments??{}, quote=payload.quote;
    const label=actions[action.kind]??action.kind;
    card.replaceChildren(el("h3","card-heading",label),el("p","card-status",statuses[action.status]??action.status));
    const context=describe(args);
    if(context) card.append(el("p","card-context",context));
    if(quote) card.append(el("strong","card-price","实付 "+money(quote.amountCents)));
    if(quote?.deliveryCents!=null) card.append(el("p","card-context","其中配送费 "+money(quote.deliveryCents)));
    for(const item of quote?.items??args.items??[]) card.append(el("p","candidate",String(item.productName??item.productCode??"餐品")+" × "+String(item.quantity??1)));
    const labels={orderId:"订单号",address:"配送地址",addressDetail:"门牌号",contactName:"收件人",phone:"手机号",spuId:"商品编号",skuId:"规格编号",points:"积分",quantity:"数量",sessionId:"预约场次",activityCode:"活动编号"};
    for(const [key,title] of Object.entries(labels)) if(args[key]!=null) card.append(el("p","card-context",title+" "+args[key]));
    card.append(details("核对完整操作内容",args));
    const result=action.result?.providerResult;
    if(action.result?.message) card.append(el("p","card-issues",action.result.message));
    if(result) {
      card.append(details("查看执行结果",result));
      const link=payment(result.payH5Url??result.order?.payH5Url);
      if(link && action.status==="succeeded") card.append(link);
    }
    if(action.status==="unknown") card.append(el("p","card-context","请在麦当劳订单或权益记录中核对。刷新仅查询本次操作状态。"));
    const status=el("p","card-status",message); status.setAttribute("aria-live","polite"); card.append(status);
    const pending=action.status==="pending" && !forceRefresh;
    if(!pending && !forceRefresh && !["submitting","unknown"].includes(action.status)) return;
    const control=button(pending?"确认"+label:"刷新操作状态",async()=>{
      control.disabled=true;
      const path="/actions/"+encodeURIComponent(action.actionId);
      try {
        const updated=pending?await api(path+"/confirm",{method:"POST",body:{expectedVersion:action.expectedVersion,quoteId:action.quoteId??null}}):await api(path);
        if(updated?.actionId!==action.actionId) throw new Error("服务返回了意外的操作记录");
        action=updated; paint();
      } catch(error) {
        paint(true,"请求结果待核对，可刷新查看。"+(error?.message??""));
      }
    });
    const controls=el("div","card-controls"); controls.append(control); card.append(controls);
  }
  paint(); return card;
}
