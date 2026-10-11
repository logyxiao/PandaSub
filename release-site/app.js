const fallback = {
  "version": "0.2.15",
  "date": "2026-10-12",
  "notes": [
    "明确拉黑和收件地址失效会自动记录；自动投递（包括编辑组）保持发件邮箱不变，选择同平台、类型匹配且未投递的可用编辑补投，无可用编辑时记录处理结果",
    "拒收对象处理完毕后计划可显示已完成，成功发送数与已处理拒收数分别统计；记录页显示被拉黑和地址失效数量，兼容历史计划并保留待确认保护",
    "收件箱新增可编辑的过稿统计正文关键词，支持去重和清空；可按当前规则重新判定历史邮件，保留人工误判及拒稿模板过滤",
    "投稿计划第三步的可用邮箱显示上次成功计划投递时间，无历史时显示暂无计划投递记录"
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
