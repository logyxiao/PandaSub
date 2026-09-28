const fallback = {
  "version": "0.2.8",
  "date": "2026-09-28",
  "notes": [
    "【邮件乱码修复】补齐 GB18030、GBK、GB2312、Big5 等编码支持，修复部分中文邮件的标题、正文、发件人名称和附件名称乱码",
    "【历史邮件修复】打开旧版乱码邮件时重新读取原邮件，同步修复标题、正文和摘要；正常缓存仍支持离线阅读",
    "【默认筛选】收件箱及工作台邮件跳转默认显示全部类型，方便查看完整来信",
    "【右侧预览】点击邮件后在右侧显示预览，左侧列表保持可操作，无需反复关闭弹窗即可切换邮件",
    "【阅读体验】当前邮件高亮，列表与正文独立滚动，切换邮件后正文回到顶部，支持 Esc 关闭预览",
    "【稳定性与布局】保留已读状态同步，避免快速切换时旧请求覆盖当前邮件，并优化小窗口下的筛选栏与预览布局"
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
