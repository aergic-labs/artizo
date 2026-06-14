const vscode = acquireVsCodeApi();

// ── State ────────────────────────────────────────────────────────

const state = {
  toggles: null,
  configPath: null,
  allExtensions: [],
  containers: [],
  volumes: [],
  commands: [],
  isRemote: false,
};

// ── Helpers ───────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const el = (tag, className, attrs) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (attrs) Object.assign(e, attrs);
  return e;
};

function post(msg) {
  vscode.postMessage(msg);
}

// ── Constants ─────────────────────────────────────────────────────

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
  { key: "gpu", label: "GPU passthrough", desc: "Mount /dev/dri" },
  {
    key: "waylandSocket",
    label: "Wayland socket",
    desc: "Mount $XDG_RUNTIME_DIR/$WAYLAND_DISPLAY",
  },
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

// ── Accordion ────────────────────────────────────────────────────

function expandAccordionFromHost(section) {
  const header = document.querySelector(
    `.accordion-header[data-section="${section}"]`,
  );
  if (header) {
    header.classList.add("open");
  }
}

// ── Section visibility ──────────────────────────────────────────

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

// ── Rendering ────────────────────────────────────────────────────

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
    const wrapper = el("div");
    const row = el("div", "list-row");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = toggles[t.key];
    cb.dataset.action = "toggleOption";
    cb.dataset.feature = t.key;
    const text = el("span");
    text.textContent = `${t.label}: ${t.desc}`;
    row.appendChild(cb);
    row.appendChild(text);
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

  const homeMount = document.querySelector(
    '[data-action="toggleOption"][data-feature="homeMount"]',
  );
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
    const row = el("div", "list-row");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = ext.enabled;
    cb.dataset.action = "toggleExtension";
    cb.dataset.extensionId = ext.id;
    const text = el("span");
    text.textContent = `${ext.label} (${ext.id})`;
    row.appendChild(cb);
    row.appendChild(text);
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
    const dir = c.localFolder ? c.localFolder.split(/[\\\/]/).pop() : "";
    const imgShort = c.image.split("/").pop() || c.image;
    info.innerHTML = `<span class="resource-name">${esc(c.name)}</span><span class="resource-meta">${c.status}, ${esc(imgShort)}${dir ? ", " + esc(dir) : ""}</span>`;
    info.title = `Image: ${c.image}\nFolder: ${c.localFolder}`;

    top.appendChild(dot);
    top.appendChild(info);

    const actions = el("div", "resource-actions");
    if (c.status !== "running") {
      const startBtn = el("button", "btn small");
      startBtn.textContent = "Start";
      startBtn.dataset.action = "containerAction";
      startBtn.dataset.containerAction = "start";
      startBtn.dataset.containerId = c.id;
      startBtn.dataset.containerName = c.name;
      actions.appendChild(startBtn);
    } else {
      const stopBtn = el("button", "btn small");
      stopBtn.textContent = "Stop";
      stopBtn.dataset.action = "containerAction";
      stopBtn.dataset.containerAction = "stop";
      stopBtn.dataset.containerId = c.id;
      stopBtn.dataset.containerName = c.name;
      actions.appendChild(stopBtn);
    }
    const removeBtn = el("button", "btn small danger");
    removeBtn.textContent = "Remove";
    removeBtn.dataset.action = "containerAction";
    removeBtn.dataset.containerAction = "remove";
    removeBtn.dataset.containerId = c.id;
    removeBtn.dataset.containerName = c.name;
    actions.appendChild(removeBtn);

    const inspectBtn = el("button", "btn small");
    inspectBtn.textContent = "Inspect";
    inspectBtn.dataset.action = "containerAction";
    inspectBtn.dataset.containerAction = "inspect";
    inspectBtn.dataset.containerId = c.id;
    inspectBtn.dataset.containerName = c.name;
    actions.appendChild(inspectBtn);

    if (c.status === "running") {
      const connBtn = el("button", "btn small");
      connBtn.textContent = "Connect";
      connBtn.dataset.action = "containerAction";
      connBtn.dataset.containerAction = c.localFolder
        ? "connectCurrentWindow"
        : "connectCurrentWindow";
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
    const row = el("div", "list-row");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = f.enabled;
    cb.dataset.action = "toggleSoftware";
    cb.dataset.featureRef = f.ref;
    cb.dataset.enabled = f.enabled;
    const text = el("span");
    text.textContent = f.label || f.ref;
    row.appendChild(cb);
    row.appendChild(text);
    list.appendChild(row);
  });
}

function renderCommands(cmdList) {
  const list = document.getElementById("command-list");
  if (!list) return;
  list.innerHTML = "";
  state.commands = cmdList || [];

  (state.commands || []).forEach((c) => {
    if (c.children) {
      const parent = el("div", "list-row command-parent");
      const label = el("span");
      label.textContent = c.label;
      const chev = el("button", "btn small chevron-btn");
      chev.textContent = "▶";
      parent.appendChild(label);
      parent.appendChild(chev);

      const children = el("div", "command-children hidden");
      c.children.forEach((child) => {
        const row = el("div", "list-row command-child");
        const clabel = el("span");
        clabel.textContent = child.label;
        const btn = el("button", "btn small");
        btn.textContent = "Go";
        btn.dataset.action = "runCommand";
        btn.dataset.command = child.id;
        row.appendChild(clabel);
        row.appendChild(btn);
        children.appendChild(row);
      });

      parent.addEventListener("click", () => {
        children.classList.toggle("hidden");
        chev.textContent = children.classList.contains("hidden") ? "▶" : "▼";
      });

      const group = el("div", "command-group");
      group.appendChild(parent);
      group.appendChild(children);
      list.appendChild(group);
    } else {
      const row = el("div", "list-row");
      const label = el("span");
      label.textContent = c.label;
      const btn = el("button", "btn small");
      btn.textContent = "Go";
      btn.dataset.action = "runCommand";
      btn.dataset.command = c.id;
      row.appendChild(label);
      row.appendChild(btn);
      list.appendChild(row);
    }
  });
}

function updateStatusBar() {
  const el = document.getElementById("status-bar");
  if (!el) return;
  if (state.isRemote) {
    el.textContent = "Connected to container";
    el.className = "status-remote";
  } else {
    el.textContent = "";
    el.className = "";
  }
}

function esc(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Event delegation ──────────────────────────────────────────────

// Top-level accordion toggles (Containers, Volumes, Config, Wizard)
document.querySelectorAll(".accordion-header").forEach((header) => {
  header.addEventListener("click", (e) => {
    if (e.target.closest(".refresh-btn")) return;
    header.classList.toggle("open");
  });
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

// ── Click handlers ────────────────────────────────────────────────

const handlers = {
  toggleAccordion(target) {
    const row = target;
    const children = row?.nextElementSibling;
    const chev = row?.querySelector(".chevron-btn");
    if (children) {
      children.classList.toggle("hidden");
      if (chev)
        chev.textContent = children.classList.contains("hidden") ? "▶" : "▼";
    }
  },

  toggleCommandGroup(target) {
    const group = target.closest(".command-group");
    const children = group?.querySelector(".command-children");
    if (children) {
      children.classList.toggle("hidden");
      target.textContent = children.classList.contains("hidden") ? "▶" : "▼";
    }
  },

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

  volumeAction(target) {
    post({
      type: "volumeAction",
      action: target.dataset.volumeAction,
      volumeName: target.dataset.volumeName,
    });
  },

  toggleOption(target) {
    if (target.type === "checkbox") return;
    const feature = target.dataset.feature;
    const enabled = target.checked;
    post({ type: "toggleOption", feature, enabled });
  },

  toggleExtension(target) {
    if (target.type === "checkbox") return;
    post({
      type: "toggleExtension",
      extensionId: target.dataset.extensionId,
      enabled: target.checked,
    });
  },

  toggleSoftware(target) {
    if (target.type === "checkbox") return;
    post({
      type: "toggleSoftware",
      featureRef: target.dataset.featureRef,
      enabled: target.checked,
    });
  },

  tabSwitch(target) {
    const tabId = target.dataset.tab;
    const parent = target.closest(".wizard-tabs");
    parent
      .querySelectorAll(".tab-btn")
      .forEach((b) => b.classList.remove("active"));
    parent
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

  if (available) {
    // Show AI content, hide no-AI fallbacks
    show(".config-tabs", true);
    show("#config-no-ai", false);
    show(".wizard-tabs", true);
    show("#wizard-section", false);
  } else {
    // Show tab containers but hide AI tab buttons, select manual tab
    show(".config-tabs", true);
    show(".wizard-tabs", true);
    show("#config-no-ai", false);
    show("#wizard-section", false);

    // Hide AI tab buttons and simplify labels
    document
      .querySelectorAll(
        ".tab-btn[data-tab='ai'], .tab-btn[data-tab='config-ai']",
      )
      .forEach((b) => (b.style.display = "none"));

    // Rename manual tabs — "Manually" is redundant when AI is gone
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

// ── Host message dispatch ─────────────────────────────────────────

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
    } else if (msg.remote) {
      state.isRemote = true;
      updateStatusBar();
      showConfigSection(false);
    } else {
      state.isRemote = false;
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
        btn.textContent = "Generate with AI";
        if (statusEl)
          statusEl.textContent =
            msg.message || "Sent to the AI chat — continue there.";
        break;
      case "done":
      case "timeout":
        btn.disabled = false;
        btn.textContent = "Generate with AI";
        if (statusEl) statusEl.textContent = msg.message || "";
        break;
      case "error":
        btn.disabled = false;
        btn.textContent = "Generate with AI";
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

// Open config file on any deliberate action inside the config manual content
let _configFileOpened = false;
const configManual = document.getElementById("config-manual-content");
if (configManual) {
  configManual.addEventListener("click", () => {
    if (!_configFileOpened) {
      _configFileOpened = true;
      post({ type: "openConfigFile" });
    }
  });
}

post({ type: "ready" });
