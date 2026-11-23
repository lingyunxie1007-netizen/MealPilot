// 门店选择只保存在本次会话。选择“当前位置”才向浏览器申请定位权限。
export function initLocation({ search, select, ensureKey }) {
  const byId = id => document.getElementById(id);
  const dialog = byId("store-dialog");
  const form = byId("store-search");
  const results = byId("store-results");
  const feedback = byId("store-feedback");
  const label = byId("store-label");
  const clear = byId("clear-store");
  let generation = 0;
  function invalidate() {
    generation++;
    results.replaceChildren();
    feedback.textContent = "";
  }
  function close() {
    invalidate();
    if (dialog.open) dialog.close();
  }
  function reset() {
    close();
    form.reset();
    label.textContent = "选择门店";
    clear.hidden = true;
  }
  byId("choose-store").onclick = () => {
    if (ensureKey()) dialog.showModal();
  };
  clear.onclick = () => { reset(); select(null, null); };
  byId("close-store").onclick = close;
  dialog.addEventListener("cancel", invalidate);
  form.addEventListener("input", invalidate);

  function render(stores, beType) {
    feedback.textContent = stores.length ? "找到 " + stores.length + " 家门店" : "附近没有匹配门店，可以换个地名或取餐方式。";
    for (const store of stores) {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      const name = document.createElement("strong");
      name.textContent = store.storeName || store.storeCode;
      button.append(name);
      const info = document.createElement("small");
      info.textContent = [
        Number.isFinite(store.distance) ? "约 " + Math.round(store.distance) + " 米" : "",
        store.businessStatus === true ? "当前营业" : store.businessStatus === false ? "当前休息" : ""
      ].filter(Boolean).join(" · ");
      if (info.textContent) button.append(info);
      if (store.address) {
        const address = document.createElement("small");
        address.textContent = store.address;
        button.append(address);
      }
      button.onclick = () => {
        select(store, beType);
        label.textContent = (beType === 5 ? "得来速 · " : "到店 · ") + name.textContent + "（更换）";
        clear.hidden = false;
        close();
      };
      row.append(button);
      results.append(row);
    }
  }
  async function lookup(usePosition) {
    invalidate();
    const current = generation;
    const beType = Number(new FormData(form).get("beType"));
    try {
      let args;
      if (usePosition) {
        feedback.textContent = "正在获取当前位置……";
        if (!window.isSecureContext) throw new Error("当前页面不支持安全定位。请通过本机 127.0.0.1 或 HTTPS 打开，也可以手动搜索。");
        if (!navigator.geolocation) throw new Error("当前浏览器没有提供定位功能，可用 Edge 或 Chrome 打开本页，或手动搜索。");
        const position = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, error => reject(new Error(({
            1: "定位权限受限。请检查浏览器对本网站的位置权限，以及系统的位置服务。",
            2: "设备暂时无法确定位置。请检查系统位置服务，或输入附近地标搜索。",
            3: "定位超时，请重试或输入附近地标搜索。"
          })[error.code] || "浏览器未返回位置，请输入附近地标搜索。")),
            {timeout: 10000, maximumAge: 60000});
        });
        args = {beType, searchType: 3, longitude: position.coords.longitude, latitude: position.coords.latitude};
      } else {
        const city = byId("store-city").value.trim();
        const keyword = byId("store-keyword").value.trim();
        if (!city || !keyword) {
          byId(!city ? "store-city" : "store-keyword").focus();
          throw new Error(!city ? "请先输入所在城市，再填写附近地标或门店名。" : "已填写城市，请再输入附近的商场、街道、地标或门店名。");
        }
        args = {beType, searchType: 2, city, keyword};
      }
      // 定位、网络回复都可能晚于用户切换城市、关闭弹窗或新建会话。
      if (current !== generation || !dialog.open) return;
      feedback.textContent = "正在查询门店……";
      const stores = await search(args);
      if (current === generation && dialog.open) render(stores, beType);
    } catch (error) {
      if (current === generation && dialog.open) feedback.textContent = error.message || "查询失败，请重试。";
    }
  }
  form.onsubmit = event => { event.preventDefault(); void lookup(false); };
  byId("locate-store").onclick = () => { void lookup(true); };
  return reset;
}
