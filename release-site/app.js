const fallback = {
  "version": "0.2.10",
  "date": "2026-10-04",
  "notes": [
    "【编辑平均回复时间】编辑库新增平均回复时间及有效样本数，按每次成功发送至首次人工回复计算，排除自动回复、退信、未回复和异常时间记录；支持历史数据，新回复到达后刷新",
    "【定时开始发送】投稿发送设置支持选择开始日期和时间，预约后到点自动开始；计划列表可查看、修改及取消预约，提前开始需确认",
    "【跟随上个计划】支持在指定前序投稿计划结束后延迟半小时、1 小时、2 小时或自定义分钟数开始，默认选择最近创建的可选前序计划",
    "【延迟计时规则】以前序计划实际发送结束时间计时，包含手动停止或失败结束；暂停、尚未开始或取消预约不触发，循环计划需停止后才计时",
    "【预约可靠性】开始时间持久保存，应用恢复运行后继续处理到期预约；启动前复查状态和时间，避免取消或改期后误启动，并防止计划互相等待及误删仍被等待的前序计划",
    "【记住发送间隔】新建计划自动沿用上次成功保存的最短、最长发送间隔，保存草稿也会记住，重启后仍保留；编辑或复制已有计划保留其自身间隔",
    "【使用提示】定时及跟随发送需要应用运行、电脑唤醒且网络可用；退出或休眠期间错过的预约会在恢复运行后开始"
  ],
  "downloads": {}
}

const $ = (id) => document.getElementById(id)

function platformName() {
  const value = `${navigator.platform || ""} ${navigator.userAgent || ""}`.toLowerCase()
  if (value.includes("win")) return "windows"
  if (value.includes("mac")) return "macos"
  return ""
}

function bindDownload(platform, release) {
  const target = $(`${platform}-download`)
  const item = release.downloads?.[platform]
  if (!target || !item?.url) return false
  target.href = item.url
  target.textContent = `下载 ${item.label || "安装包"}`
  target.classList.remove("is-disabled")
  target.removeAttribute("aria-disabled")
  if (item.detail) $(`${platform}-detail`).textContent = item.detail
  return true
}

function render(release) {
  const version = String(release.version || fallback.version).replace(/^v/, "")
  $("hero-version").textContent = `v${version}`
  $("release-version").textContent = `v${version}`
  $("footer-version").textContent = `桌面版 v${version}`
  $("release-date").textContent = release.date || ""
  $("release-list").replaceChildren(...(release.notes?.length ? release.notes : fallback.notes).map((note) => {
    const li = document.createElement("li")
    li.textContent = note
    return li
  }))

  bindDownload("windows", release)
  bindDownload("macos", release)

  const detected = platformName()
  const detectedRelease = release.downloads?.[detected]
  const primary = $("primary-download")
  if (detected && detectedRelease?.url) {
    primary.href = detectedRelease.url
    $("primary-label").textContent = `下载 ${detected === "windows" ? "Windows" : "macOS"} 版`
    $("primary-meta").textContent = `v${version} · ${detectedRelease.detail || "最新版"}`
    primary.classList.remove("is-disabled")
    primary.removeAttribute("aria-disabled")
  } else {
    primary.href = "#downloads"
    $("primary-label").textContent = detected ? "该平台版本准备中" : "选择下载版本"
    $("primary-meta").textContent = `当前最新版 v${version}`
    primary.classList.remove("is-disabled")
    primary.removeAttribute("aria-disabled")
  }
}

fetch("release.json", { cache: "no-store" })
  .then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  })
  .then(render)
  .catch(() => render(fallback))
