const fallback = {
  "version": "0.2.9",
  "date": "2026-10-03",
  "notes": [
    "【暂停收稿分类】收件箱新增“暂停收稿”筛选，识别主题或正文包含该词的历史及新邮件，列表与预览同步显示标记",
    "【批量管理编辑】直接勾选邮件即可批量暂停、启用或删除对应编辑，支持全选本页、跨页保留选择、编辑去重及未匹配提示，无需逐封打开",
    "【批量操作保障】删除前列明编辑与邮箱，保留邮件及投递历史；批量保存失败完整回滚，勾选不改变邮件已读状态，切换筛选自动清空选择",
    "【暂停投递生效】停用编辑后，后续自动投递、手动发送及重发均检查启用状态；支持在邮件预览中快速恢复，启用后可重新安排投递",
    "【编辑拉黑记录】识别明确的 550 收件人拉黑拒绝，按发件邮箱与收稿邮箱记录，可在编辑库查看、筛选和清除已解除的标记",
    "【同平台自动替换】自动投递遇到已记录的拉黑时，尝试符合稿件类型的同平台可用编辑，保持发件邮箱不变，并提示替换结果或无可用编辑原因",
    "【默认编辑库补充】新增 40 条编辑资料并更新 9 条已有资料；未明确或截断且无法核实的联系方式暂不导入",
    "【构建兼容性】清理未使用函数警告，修复 IMAP 依赖的 Rust 未来兼容性警告"
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
