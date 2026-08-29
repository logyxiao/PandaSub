const fallback = {
  "version": "0.2.1",
  "date": "2026-08-29",
  "notes": [
    "新增投稿模板使用方式，支持默认随机或为单个投稿计划固定指定模板",
    "优化默认投稿模板，修改后自动保存并用于后续新计划",
    "修复 QQ 邮箱自动回复漏读问题，升级后自动补扫近 14 天遗漏回复",
    "提升重复主题和多发件邮箱场景下的回复关联准确性"
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
