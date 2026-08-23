const vscode = acquireVsCodeApi();

// State
const state = {
  toggles: null,
  configPath: null,
  allExtensions: [],
  containers: [],
  volumes: [],
  commands: [],
  isManaged: false,
};

// Helpers
const el = (tag, className, attrs) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (attrs) Object.assign(e, attrs);
  return e;
};

function post(msg) {
  vscode.postMessage(msg);
}

// Constants
const COMMON_IMAGES = [
  { label: "Ubuntu", image: "mcr.microsoft.com/devcontainers/base:ubuntu" },
  { label: "Python 3", image: "mcr.microsoft.com/devcontainers/python:3" },
  {
    label: "Node.js",
    image: "mcr.microsoft.com/devcontainers/typescript-node:22",
  },
  { label: "Rust", image: "mcr.microsoft.com/devcontainers/rust:1" },
  { label: "Go", image: "mcr.microsoft.com/devcontainers/go:1" },
  { label: "Java", image: "mcr.microsoft.com/devcontainers/java:21" },
  { label: ".NET", image: "mcr.microsoft.com/devcontainers/dotnet:9.0" },
  { label: "Alpine", image: "mcr.microsoft.com/devcontainers/base:alpine" },
];

const TOGGLES = [
  { key: "gpu", label: "GPU passthrough", desc: "Pass through GPU (--gpus all)" },
  {
    key: "mountHome",
    label: "Mount home",
    desc: "Mount home directory into container",
  },
  {
    key: "privileged",
    label: "Privileged mode",
    desc: "Run container with --privileged",
  },
  { key: "sshAgent", label: "SSH agent", desc: "Forward SSH agent socket" },
  {
    key: "copyGitConfig",
    label: "Git config",
    desc: "Copy .gitconfig into container",
  },
];

// Accordion
function expandAccordionFromHost(section) {
  const header = document.querySelector(
    `.accordion-header[data-section="${section}"]`,
  );
  if (header) {
    header.classList.add("open");
  }
}

// Section visibility
function showConfigSection(hasConfig) {
  const config = document.getElementById("config-section");
  const wizard = document.getElementById("empty-config");
  if (hasConfig) {
    config.classList.remove("hidden");
    wizard.classList.add("hidden");
  } else {
    config.classList.add("hidden");
    wizard.classList.remove("hidden");
  }
}

function showNoWorkspace() {
  document.getElementById("config-section").classList.add("hidden");
  document.getElementById("empty-config").classList.add("hidden");
  document.getElementById("empty-config-msg").textContent =
    "Open a workspace folder to configure a dev container.";
}

/**
 * Inside a managed devcontainer window. Hide the config editor, the
 * "add devcontainer.json" wizard, and the Containers/Volumes accordions -
 * none of these make sense when you're already running inside a
 * container (you can't reopen-in-container, stop the container you're
 * in, or attach to another one from here). The Commands section is
 * kept: it correctly trims to "Reopen in Host" / "Close Remote Connection"
 * / "Show Log" / "Remote Menu" when managed.
 */
function showManaged() {
  document.getElementById("config-section").classList.add("hidden");
  document.getElementById("empty-config").classList.add("hidden");
  // The Containers and Volumes sections don't have ids; target them via
  // their accordion-header data-section attributes and hide the parent
  // .accordion-group.
  document
    .querySelectorAll(
      '.accordion-header[data-section="containers"], .accordion-header[data-section="volumes"]',
    )
    .forEach((header) => {
      const group = header.closest(".accordion-group");
      if (group) group.classList.add("hidden");
    });
}

// Rendering
function renderWizardImages() {
  const list = document.getElementById("wizard-images");
  if (!list) return;
  list.innerHTML = "";
  COMMON_IMAGES.forEach((img) => {
    const row = el("div", "list-row wizard-image-row");
    const label = el("span");
    label.textContent = `${img.label}, ${img.image}`;
    const btn = el("button", "btn small");
    btn.textContent = "Use";
    btn.dataset.action = "generateConfig";
    btn.dataset.image = img.image;
    row.appendChild(label);
    row.appendChild(btn);
    list.appendChild(row);
  });
}

function renderToggles(toggles) {
  const list = document.getElementById("toggle-list");
  if (!list) return;
  list.innerHTML = "";
  TOGGLES.forEach((t) => {
    const wrapper = el("div", "toggle-wrapper");
    const row = el("div", "toggle-row");
    const title = el("div", "toggle-title");
    const cb = el("input", "toggle-checkbox");
    cb.type = "checkbox";
    cb.checked = toggles[t.key];
    cb.dataset.action = "toggleOption";
    cb.dataset.feature = t.key;
    const label = el("span", "toggle-label");
    label.textContent = t.label;
    title.appendChild(cb);
    title.appendChild(label);
    const desc = el("div", "toggle-desc");
    desc.textContent = t.desc;
    row.appendChild(title);
    row.appendChild(desc);
    wrapper.appendChild(row);

    if (t.key === "mountHome" && toggles[t.key]) {
      const pathRow = el("div", "add-row");
      const input = el("input");
      input.type = "text";
      input.placeholder = toggles.homeMountPath || "Home path";
      input.dataset.action = "setMountPath";
      input.dataset.feature = "mountHome";
      pathRow.appendChild(input);
      wrapper.appendChild(pathRow);
    }

    list.appendChild(wrapper);
  });
}

function renderPorts(ports) {
  const list = document.getElementById("port-list");
  if (!list) return;
  list.innerHTML = "";
  (ports || []).forEach((p, i) => {
    const row = el("div", "list-row port-row");
    const text = el("span");
    text.textContent = p.label ? `${p.port} (${p.label})` : `${p.port}`;
    const rm = el("button", "btn small");
    rm.textContent = "Remove";
    rm.dataset.action = "removePort";
    rm.dataset.index = i;
    row.appendChild(text);
    row.appendChild(rm);
    list.appendChild(row);
  });
}

function renderExtensions(exts) {
  const list = document.getElementById("extension-list");
  if (!list) return;
  list.innerHTML = "";
  (exts || []).forEach((id, i) => {
    const row = el("div", "list-row");
    const text = el("span");
    text.textContent = id;
    const rm = el("button", "btn small");
    rm.textContent = "Remove";
    rm.dataset.action = "removeExtension";
    rm.dataset.index = i;
    row.appendChild(text);
    row.appendChild(rm);
    list.appendChild(row);
  });
}

function renderExtensionChecklist(exts) {
  const filter = document.getElementById("extension-filter");
  const filterText = (filter?.value || "").toLowerCase().trim();
  const list = document.getElementById("extension-checklist");
  if (!list) return;
  list.innerHTML = "";
  state.allExtensions = exts || [];
  const filtered = filterText
    ? state.allExtensions.filter(
        (e) =>
          e.id.toLowerCase().includes(filterText) ||
          e.label.toLowerCase().includes(filterText),
      )
    : state.allExtensions;
  filtered.forEach((ext) => {
    const row = el("div", "toggle-row");
    const title = el("div", "toggle-title");
    const cb = el("input", "toggle-checkbox");
    cb.type = "checkbox";
    cb.checked = ext.enabled;
    cb.dataset.action = "toggleExtension";
    cb.dataset.extensionId = ext.id;
    const label = el("span", "toggle-label");
    label.textContent = `${ext.label} (${ext.id})`;
    title.appendChild(cb);
    title.appendChild(label);
    row.appendChild(title);
    list.appendChild(row);
  });
}

function renderContainers(containers) {
  const list = document.getElementById("container-list");
  const empty = document.getElementById("container-empty");
  if (!list) return;
  list.innerHTML = "";
  const cs = containers || [];
  if (cs.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  cs.forEach((c) => {
    const row = el("div", "resource-row");
    const top = el("div", "resource-top");
    const dot = el("span", "status-dot " + c.status);
    const info = el("span", "resource-info");
    const dir = c.localFolder ? basename(c.localFolder) : "";
    const imgShort = basename(c.image) || c.image;
    info.innerHTML = `<span class="resource-name">${esc(c.name)}</span><span class="resource-meta">${c.status}, ${esc(imgShort)}${dir ? ", " + esc(dir) : ""}</span>`;
    info.title = `Image: ${c.image}\nFolder: ${c.localFolder}`;

    top.appendChild(dot);
    top.appendChild(info);

    const actions = el("div", "resource-actions");
    if (c.status !== "running") {
      const startBtn = el("button", "btn small");
      startBtn.title = "Start";
      const startIcon = el("span", "codicon codicon-play-circle");
      startBtn.appendChild(startIcon);
      startBtn.dataset.action = "containerAction";
      startBtn.dataset.containerAction = "start";
      startBtn.dataset.containerId = c.id;
      startBtn.dataset.containerName = c.name;
      actions.appendChild(startBtn);
    } else {
      const stopBtn = el("button", "btn small");
      stopBtn.title = "Stop";
      const stopIcon = el("span", "codicon codicon-stop-circle");
      stopBtn.appendChild(stopIcon);
      stopBtn.dataset.action = "containerAction";
      stopBtn.dataset.containerAction = "stop";
      stopBtn.dataset.containerId = c.id;
      stopBtn.dataset.containerName = c.name;
      actions.appendChild(stopBtn);
    }
    const removeBtn = el("button", "btn small danger");
    removeBtn.title = "Remove";
    const removeIcon = el("span", "codicon codicon-trash");
    removeBtn.appendChild(removeIcon);
    removeBtn.dataset.action = "containerAction";
    removeBtn.dataset.containerAction = "remove";
    removeBtn.dataset.containerId = c.id;
    removeBtn.dataset.containerName = c.name;
    actions.appendChild(removeBtn);

    const inspectBtn = el("button", "btn small");
    inspectBtn.title = "Inspect";
    const inspectIcon = el("span", "codicon codicon-zoom-in");
    inspectBtn.appendChild(inspectIcon);
    inspectBtn.dataset.action = "containerAction";
    inspectBtn.dataset.containerAction = "inspect";
    inspectBtn.dataset.containerId = c.id;
    inspectBtn.dataset.containerName = c.name;
    actions.appendChild(inspectBtn);

    if (c.status === "running") {
      const connBtn = el("button", "btn small");
      connBtn.title = "Connect";
      const connIcon = el("span", "codicon codicon-terminal");
      connBtn.appendChild(connIcon);
      connBtn.dataset.action = "containerAction";
      connBtn.dataset.containerAction = c.localFolder
        ? "connectCurrentWindow"
        : "connectNewWindow";
      connBtn.dataset.containerId = c.id;
      connBtn.dataset.containerName = c.name;
      actions.appendChild(connBtn);
    }

    row.appendChild(top);
    row.appendChild(actions);

    list.appendChild(row);
  });
}

function renderVolumes(volumes) {
  const list = document.getElementById("volume-list");
  const empty = document.getElementById("volume-empty");
  if (!list) return;
  list.innerHTML = "";
  const vs = volumes || [];
  if (vs.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  vs.forEach((v) => {
    const row = el("div", "resource-row");
    const info = el("span", "resource-info");
    info.innerHTML = `<span class="resource-name">${esc(v.name)}</span><span class="resource-meta">${esc(v.driver)}${v.size ? " &middot; " + esc(v.size) : ""}</span>`;
    const actions = el("span", "resource-actions");

    const inspectBtn = el("button", "btn small");
    inspectBtn.textContent = "Inspect";
    inspectBtn.dataset.action = "volumeAction";
    inspectBtn.dataset.volumeAction = "inspect";
    inspectBtn.dataset.volumeName = v.name;
    actions.appendChild(inspectBtn);

    const removeBtn = el("button", "btn small danger");
    removeBtn.textContent = "Remove";
    removeBtn.dataset.action = "volumeAction";
    removeBtn.dataset.volumeAction = "remove";
    removeBtn.dataset.volumeName = v.name;
    actions.appendChild(removeBtn);
    row.appendChild(info);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

function renderSoftware(features) {
  const list = document.getElementById("software-list");
  if (!list) return;
  list.innerHTML = "";
  (features || []).forEach((f) => {
    const row = el("div", "toggle-row");
    const title = el("div", "toggle-title");
    const cb = el("input", "toggle-checkbox");
    cb.type = "checkbox";
    cb.checked = f.enabled;
    cb.dataset.action = "toggleSoftware";
    cb.dataset.featureRef = f.ref;
    cb.dataset.enabled = f.enabled;
    const label = el("span", "toggle-label");
    label.textContent = f.label || f.ref;
    title.appendChild(cb);
    title.appendChild(label);
    row.appendChild(title);
    list.appendChild(row);
  });
}

// Icon for a specific command id.
// Missing entries default to no icon.
const ICON_MAP = {
  "artizo.reopenInContainer": "codicon-issue-reopened",
  "artizo.reopenInContainerNewWindow": "codicon-issue-reopened",
  "artizo.rebuildContainer": "codicon-tools",
  "artizo.rebuildContainerNoCache": "codicon-tools",
  "artizo.rebuildAndReopenInContainer": "codicon-tools",
  "artizo.openFolderInContainer": "codicon-folder-opened",
  "artizo.openFolderInContainerNewWindow": "codicon-folder-opened",
  "artizo.cleanUpContainers": "codicon-trash",
  "artizo.revealOutputLog": "codicon-output",
  "artizo.reopenInHost": "codicon-home",
  "artizo.closeRemoteConnection": "codicon-debug-disconnect",
  "workbench.action.remote.showMenu": "codicon-menu",
};

function cmdIcon(id) {
  return ICON_MAP[id] || "";
}

function renderCommands(cmdList) {
  const list = document.getElementById("command-list");
  if (!list) return;
  list.innerHTML = "";
  state.commands = cmdList || [];

  (state.commands || []).forEach((c) => {
    if (c.children) {
      // Render as a standard accordion, same as Containers/Volumes
      const group = el("div", "accordion-group");
      const header = el("div", "accordion-header open");
      const chev = el("span", "chevron codicon codicon-chevron-down");
      const label = el("span", "label");
      label.textContent = c.label;
      header.appendChild(chev);
      header.appendChild(label);

      const body = el("div", "accordion-body");
      c.children.forEach((child) => {
        const row = el("div", "command-row");
        row.dataset.action = "runCommand";
        row.dataset.command = child.id;
        const iconClass = cmdIcon(child.id);
        if (iconClass) {
          const icon = el("span", `codicon ${iconClass} cmd-icon`);
          row.appendChild(icon);
        }
        const clabel = el("span", "cmd-label");
        clabel.textContent = child.label;
        row.appendChild(clabel);
        body.appendChild(row);
      });

      group.appendChild(header);
      group.appendChild(body);
      list.appendChild(group);
    } else {
      const row = el("div", "command-row");
      row.dataset.action = "runCommand";
      row.dataset.command = c.id;
      const iconClass = cmdIcon(c.id);
      if (iconClass) {
        const icon = el("span", `codicon ${iconClass} cmd-icon`);
        row.appendChild(icon);
      }
      const label = el("span", "cmd-label");
      label.textContent = c.label;
      row.appendChild(label);
      list.appendChild(row);
    }
  });
}

function updateStatusBar() {
  const el = document.getElementById("status-bar");
  if (!el) return;
  if (state.isManaged) {
    el.textContent = "Connected to dev container";
    el.className = "status-managed";
  } else {
    el.textContent = "";
    el.className = "";
  }
}

function esc(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Get the last segment of a path, handling both / and \ separators. */
function basename(p) {
  if (!p) return "";
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

// Event delegation — all accordion toggles
// Handles both static (Containers, Volumes, Wizard, Config, sub-accordions)
// and dynamic (command groups rendered by renderCommands)
document.addEventListener("click", (e) => {
  const header = e.target.closest(".accordion-header");
  if (header) {
    if (e.target.closest(".refresh-btn")) return;
    const wasOpen = header.classList.contains("open");
    header.classList.toggle("open");
    if (!wasOpen) {
      const section = header.dataset.section;
      if (section === "containers" || section === "volumes") {
        post({ type: "refreshSection", section });
      }
      if (section === "config") {
        post({ type: "openConfigFile" });
      }
    }
    return;
  }

  const subHeader = e.target.closest(".sub-accordion-header");
  if (subHeader) {
    subHeader.classList.toggle("open");
    return;
  }
});

document.addEventListener("click", (e) => {
  const target = e.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  handlers[action]?.(target, e);
});

document.addEventListener("change", (e) => {
  const target = e.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  changeHandlers[action]?.(target, e);
});

// Toggle row click → checkbox
// Clicking anywhere on a .toggle-row flips its checkbox (which fires
// the change event and posts the toggleOption message).
document.addEventListener("click", (e) => {
  const row = e.target.closest(".toggle-row");
  if (!row) return;
  // If the click was directly on the checkbox, let native behavior
  // handle it and stopPropagation below to avoid double-toggle.
  if (e.target.classList.contains("toggle-checkbox")) return;
  const cb = row.querySelector(".toggle-checkbox");
  if (cb) {
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event("change", { bubbles: true }));
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const target = e.target.closest("input");
    if (!target) return;
    if (target.id === "extension-filter") {
      const id = target.value.trim();
      if (id && !state.allExtensions.some((ext) => ext.id === id)) {
        post({ type: "addExtension", extensionId: id });
        target.value = "";
      }
    } else if (target.id === "wizard-image-input") {
      const image = target.value.trim();
      if (!image) return;
      post({ type: "generateConfig", image });
    }
  }
});

// Click handlers
const handlers = {
  runCommand(target) {
    post({ type: "runCommand", command: target.dataset.command });
  },

  refreshSection(target) {
    post({ type: "refreshSection", section: target.dataset.section });
  },

  generateConfig(target) {
    const image =
      target.dataset.image ||
      document.getElementById("wizard-image-input")?.value?.trim();
    if (image) post({ type: "generateConfig", image });
  },

  aiGenerate() {
    post({ type: "aiGenerateConfig" });
  },

  aiUpdateConfig() {
    post({ type: "aiUpdateConfig" });
  },

  aiFixConfig() {
    post({ type: "aiFixConfig" });
  },

  openConfig() {
    post({ type: "openConfigFile" });
  },

  repairConfig() {
    post({ type: "repairConfig" });
  },

  showErrors() {
    const list = document.getElementById("config-error-list");
    if (list) list.classList.toggle("hidden");
  },

  addPort() {
    const port = parseInt(document.getElementById("port-input")?.value);
    const label = document.getElementById("port-label-input")?.value || "";
    if (port) {
      post({ type: "addPort", port, label });
      document.getElementById("port-input").value = "";
      document.getElementById("port-label-input").value = "";
    }
  },

  addSoftware() {
    const input = document.getElementById("software-input");
    const ref = input?.value?.trim();
    if (ref) {
      post({ type: "toggleSoftware", featureRef: ref, enabled: true });
      input.value = "";
    }
  },

  removePort(target) {
    post({ type: "removePort", index: parseInt(target.dataset.index) });
  },

  removeExtension(target) {
    post({ type: "removeExtension", index: parseInt(target.dataset.index) });
  },

  containerAction(target) {
    post({
      type: "containerAction",
      action: target.dataset.containerAction,
      containerId: target.dataset.containerId,
      containerName: target.dataset.containerName,
    });
  },

  cloneInVolume() {
    post({ type: "cloneInVolume" });
  },

  createVolume() {
    post({ type: "createVolume" });
  },

  volumeAction(target) {
    post({
      type: "volumeAction",
      action: target.dataset.volumeAction,
      volumeName: target.dataset.volumeName,
    });
  },

  tabSwitch(target) {
    const tabId = target.dataset.tab;
    const parent = target.closest(".tab-bar");
    if (!parent) return;
    parent
      .querySelectorAll(".tab-btn")
      .forEach((b) => b.classList.remove("active"));
    // Deactivate all tab-panels within the same parent container
    const container = parent.parentElement;
    container
      .querySelectorAll(".tab-panel")
      .forEach((p) => p.classList.remove("active"));
    target.classList.add("active");
    const panel = document.getElementById(`tab-${tabId}`);
    if (panel) panel.classList.add("active");

    // Toggle config manual content visibility
    if (tabId === "config-ai" || tabId === "config-manual") {
      const manual = document.getElementById("config-manual-content");
      if (manual) {
        manual.classList.toggle("hidden", tabId === "config-ai");
      }
    }
  },
};

// Change handlers (for inputs, selects)
const changeHandlers = {
  toggleOption(target) {
    const feature = target.dataset.feature;
    const enabled = target.checked;
    post({ type: "toggleOption", feature, enabled });
  },
  toggleExtension(target) {
    post({
      type: "toggleExtension",
      extensionId: target.dataset.extensionId,
      enabled: target.checked,
    });
  },
  toggleSoftware(target) {
    post({
      type: "toggleSoftware",
      featureRef: target.dataset.featureRef,
      enabled: target.checked,
    });
  },
};

/** Hide or show AI tabs based on whether an AI extension is installed. */
function gateAiContent(available) {
  const show = (sel, v) => {
    document.querySelectorAll(sel).forEach((el) => {
      el.style.display = v ? "" : "none";
    });
  };

  // Tab containers are always visible; no-AI fallback is always hidden
  // (manual tab covers the no-AI case).
  show(".config-tabs", true);
  show(".tab-bar", true);
  show("#config-no-ai", false);
  show("#wizard-section", false);

  if (!available) {
    // Hide AI tab buttons
    document
      .querySelectorAll(
        ".tab-btn[data-tab='ai'], .tab-btn[data-tab='config-ai']",
      )
      .forEach((b) => (b.style.display = "none"));

    // Rename manual tabs - "Manually" is redundant when AI is gone
    document
      .querySelectorAll(
        ".tab-btn[data-tab='manual'], .tab-btn[data-tab='config-manual']",
      )
      .forEach((b) => {
        b.textContent = b.dataset.tab === "config-manual" ? "Edit" : "Create";
        b.classList.add("active");
        b.click();
      });
  }
}

document.getElementById("extension-filter")?.addEventListener("input", () => {
  if (state.allExtensions.length) {
    renderExtensionChecklist(state.allExtensions);
  }
});

// Host message dispatch
const messageHandlers = {
  configLoaded(msg) {
    state.toggles = msg.toggles;
    state.configPath = msg.path;
    showConfigSection(true);
    expandAccordionFromHost("config");
    renderToggles(msg.toggles);
    renderPorts(msg.toggles.forwardPorts);
    renderExtensions(msg.toggles.extensions);
    renderSoftware(msg.software);

    // Show AI tabs only when an AI extension is available
    gateAiContent(msg.aiAvailable);

    const banner = document.getElementById("config-error-banner");
    if (!banner) return;
    if (msg.errors && msg.errors.length > 0) {
      const count = msg.errors.length;
      const maxShow = 5;
      const list = msg.errors
        .slice(0, maxShow)
        .map((e) => `<li>Line ${e.line}, col ${e.column}: ${e.message}</li>`)
        .join("");
      const more =
        count > maxShow
          ? `<li><em>...and ${count - maxShow} more</em></li>`
          : "";
      banner.innerHTML = `
        <strong><span style="background:#d32f2f;color:#fff;padding:1px 5px;border-radius:3px;margin-right:4px">&#9888;</span> ${count} parse error${count !== 1 ? "s" : ""} in devcontainer.json</strong>
        <div style="display:flex;flex-direction:column;gap:4px;margin-top:6px">
          <button id="config-show-errors-btn" class="btn small" data-action="showErrors">Show errors</button>
          <button id="config-repair-btn" class="btn small" data-action="repairConfig">&#128736; Fix now</button>
        </div>
        ${msg.aiAvailable ? `<div style="margin-top:6px;text-align:center"><a href="#" data-action="aiFixConfig" class="subtle-link">or fix with ai</a></div>` : ""}
        <ul id="config-error-list" class="hidden" style="margin-top:6px">${list}${more}</ul>
      `;
      banner.classList.remove("hidden");
    } else if (msg.errors) {
      banner.classList.add("hidden");
    }
  },

  configMissing(msg) {
    gateAiContent(msg.aiAvailable);

    if (msg.noWorkspace) {
      showNoWorkspace();
    } else if (msg.managed) {
      state.isManaged = true;
      updateStatusBar();
      showManaged();
    } else {
      state.isManaged = false;
      showConfigSection(false);
      renderWizardImages();
      document.getElementById("wizard-image-input")?.focus();
    }
  },

  optionToggled(msg) {
    if (state.toggles && state.toggles[msg.feature] !== undefined) {
      state.toggles[msg.feature] = msg.enabled;
    }
  },

  updateContainers(msg) {
    renderContainers(msg.containers);
  },

  updateVolumes(msg) {
    renderVolumes(msg.volumes);
  },

  expandSection(msg) {
    expandAccordionFromHost(msg.section);
  },

  updateCommands(msg) {
    renderCommands(msg.commands);
  },

  setInstalledExtensions(msg) {
    renderExtensionChecklist(msg.extensions);
  },

  switchTab(msg) {
    const tab = document.querySelector(`.tab-btn[data-tab="${msg.tab}"]`);
    if (tab) tab.click();
  },

  aiStatus(msg) {
    const target = msg.target || "wizard";
    const btnId = target === "config" ? "config-ai-btn" : "wizard-ai-btn";
    const statusId = target === "config" ? "config-ai-status" : "ai-status";
    const btn = document.getElementById(btnId);
    const statusEl = document.getElementById(statusId);
    if (!btn) return;
    const idleLabel = target === "config" ? "Update with AI" : "Create with AI";
    switch (msg.status) {
      case "generating":
        btn.disabled = true;
        btn.textContent = "Analyzing project...";
        if (statusEl) statusEl.textContent = "";
        break;
      case "questions":
        btn.disabled = true;
        btn.textContent = "Waiting for your answers...";
        if (statusEl) statusEl.textContent = msg.message || "";
        break;
      case "submitted":
        btn.disabled = false;
        btn.textContent = idleLabel;
        if (statusEl)
          statusEl.textContent =
            msg.message || "Sent to the AI chat - continue there.";
        break;
      case "done":
      case "timeout":
        btn.disabled = false;
        btn.textContent = idleLabel;
        if (statusEl) statusEl.textContent = msg.message || "";
        break;
      case "error":
        btn.disabled = false;
        btn.textContent = idleLabel;
        if (statusEl)
          statusEl.textContent = msg.message || "Something went wrong.";
        break;
    }
  },
};

window.addEventListener("message", (event) => {
  const msg = event.data;
  const handler = messageHandlers[msg.type];
  if (handler) handler(msg);
});

// Auto-open devcontainer.json in the editor when the user enters the
// config widget area, if the file exists and isn't already the active
// editor tab. The host-side handler does the active-tab check.
const configSection = document.getElementById("config-section");
if (configSection) {
  configSection.addEventListener("mouseenter", () => {
    post({ type: "openConfigFile" });
  });
}

post({ type: "ready" });
