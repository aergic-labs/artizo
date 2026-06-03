/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const vscode = acquireVsCodeApi();

let toggles = {};
let configPath = "";
let _containerCount = 0;
let _volumeCount = 0;
let _isRemote = false;
let _containerFirstLoad = false;
let _volumeFirstLoad = false;

const TOGGLES = [
  {
    key: "gpu",
    label: "GPU Access",
    desc: "Mount GPUs into the container (--gpus all)",
  },
  {
    key: "waylandSocket",
    label: "Wayland Socket",
    desc: "Mount Wayland display socket",
  },
  {
    key: "mountHome",
    label: "Mount Home Directory",
    desc: "Mount host home into container",
  },
  {
    key: "privileged",
    label: "Privileged Mode",
    desc: "Run container with --privileged",
  },
  {
    key: "sshAgent",
    label: "SSH Agent Forwarding",
    desc: "Forward SSH agent socket",
  },
  {
    key: "copyGitConfig",
    label: "Copy Git Config",
    desc: "Copy host .gitconfig into container",
  },
];

// ── Accordion toggles ────────────────────────────────────────

function expandAccordionFromHost(section) {
  const header = document.querySelector(
    `.accordion-header[data-section="${section}"], .refresh-btn[data-section="${section}"]`,
  );
  console.log(`expandAccordionFromHost: section=${section} found=${!!header}`);
  if (header) {
    const h = header.classList.contains("accordion-header")
      ? header
      : header.closest(".accordion-header");
    if (h) {
      h.classList.add("open");
      h.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
}

document.querySelectorAll(".accordion-header").forEach((header) => {
  header.addEventListener("click", (e) => {
    if (e.target.closest(".refresh-btn")) return;
    header.classList.toggle("open");
  });
});

// ── Conditional sections ──────────────────────────────────────

function showConfigSection(hasConfig) {
  document
    .getElementById("config-section")
    .classList.toggle("hidden", !hasConfig);
  document.getElementById("empty-config").classList.toggle("hidden", hasConfig);
}

function showNoWorkspace() {
  document.getElementById("config-section").classList.add("hidden");
  document.getElementById("empty-config").classList.remove("hidden");
  document.getElementById("empty-config-msg").textContent =
    "Open a folder to configure a dev container.";
  document.getElementById("add-config-btn").classList.add("hidden");
}

// ── Wizard rendering ────────────────────────────────────────

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

function renderWizardImages() {
  const list = document.getElementById("wizard-images");
  list.innerHTML = "";
  COMMON_IMAGES.forEach((img) => {
    const row = el("div", "list-row wizard-image-row");
    const label = el("span");
    label.textContent = `${img.label}, ${img.image}`;
    const btn = el("button", "btn small");
    btn.textContent = "Use";
    btn.addEventListener("click", () => {
      post({ type: "generateConfig", image: img.image });
    });
    row.appendChild(label);
    row.appendChild(btn);
    list.appendChild(row);
  });
}

function el(tag, className, attrs) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (attrs) Object.assign(e, attrs);
  return e;
}

function renderToggles(feats) {
  const list = document.getElementById("toggle-list");
  list.innerHTML = "";
  TOGGLES.forEach((f) => {
    const wrapper = el("div", "toggle-wrapper");
    const row = el("label", "toggle-row");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = !!feats[f.key];
    cb.addEventListener("change", () => {
      const opts = {
        type: "toggleOption",
        feature: f.key,
        enabled: cb.checked,
      };
      if (f.key === "mountHome") {
        const input = document.getElementById("mount-path");
        if (input) {
          opts.mountPath = input.value || "/host-home";
        }
      }
      post(opts);
    });
    const text = el("span", "toggle-text");
    text.innerHTML = `<strong>${f.label}</strong><br><small>${f.desc}</small>`;
    row.appendChild(cb);
    row.appendChild(text);
    wrapper.appendChild(row);

    if (f.key === "mountHome" && cb.checked) {
      const pathRow = el("div", "mount-path-row");
      const input = el("input", "mount-path-input");
      input.id = "mount-path";
      input.type = "text";
      input.placeholder = "/host-home";
      const homeMount = (feats.mounts || []).find((m) =>
        (m.source || "").includes("HOME"),
      );
      input.value = homeMount?.target || "";
      const applyBtn = el("button", "btn small");
      applyBtn.textContent = "Apply";
      applyBtn.addEventListener("click", () => {
        post({
          type: "toggleOption",
          feature: "mountHome",
          enabled: true,
          mountPath: input.value || "/host-home",
        });
      });
      pathRow.appendChild(input);
      pathRow.appendChild(applyBtn);
      wrapper.appendChild(pathRow);
    }

    list.appendChild(wrapper);
  });
}

function renderPorts(ports) {
  const list = document.getElementById("port-list");
  list.innerHTML = "";
  (ports || []).forEach((p, i) => {
    const row = el("div", "list-row");
    row.innerHTML = `<span>${p.port}${p.label ? ": " + p.label : ""}</span>`;
    const rm = el("button", "btn small");
    rm.textContent = "\u00d7";
    rm.addEventListener("click", () => post({ type: "removePort", index: i }));
    row.appendChild(rm);
    list.appendChild(row);
  });
}

function renderExtensions(exts) {
  // Kept for raw-entered IDs that aren't in the checklist
  const list = document.getElementById("extension-list");
  list.innerHTML = "";
}

let _allExtensions = [];

function renderExtensionChecklist(extensions) {
  _allExtensions = extensions;
  const filterText = document
    .getElementById("extension-filter")
    .value.toLowerCase();
  const list = document.getElementById("extension-checklist");
  list.innerHTML = "";

  const filtered = extensions.filter(
    (e) =>
      !filterText ||
      e.id.toLowerCase().includes(filterText) ||
      e.label.toLowerCase().includes(filterText),
  );

  filtered.forEach((e) => {
    const row = el("label", "toggle-row");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = e.enabled;
    cb.addEventListener("change", () => {
      if (cb.checked) {
        post({ type: "addExtension", extensionId: e.id });
      } else {
        const idx = _allExtensions
          .filter((x) => x.enabled)
          .findIndex((x) => x.id === e.id);
        if (idx >= 0) {
          post({ type: "removeExtension", index: idx });
        }
      }
      e.enabled = cb.checked;
    });
    const text = el("span", "toggle-text");
    text.innerHTML = `<strong>${esc(e.label)}</strong><br><small>${esc(e.id)}</small>`;
    row.appendChild(cb);
    row.appendChild(text);
    list.appendChild(row);
  });
}

function renderContainers(containers) {
  _containerCount = (containers || []).length;
  updateStatusBar();
  const list = document.getElementById("container-list");
  const empty = document.getElementById("container-empty");
  list.innerHTML = "";
  if (!containers || containers.length === 0) {
    if (_containerFirstLoad) {
      empty.classList.remove("hidden");
    }
    return;
  }
  empty.classList.add("hidden");

  containers.forEach((c) => {
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

    if (c.status === "stopped") {
      const startBtn = el("button", "btn small");
      startBtn.textContent = "Start";
      startBtn.addEventListener("click", () =>
        post({
          type: "containerAction",
          action: "start",
          containerId: c.id,
          containerName: c.name,
        }),
      );
      actions.appendChild(startBtn);
    }
    if (c.status === "running") {
      const stopBtn = el("button", "btn small");
      stopBtn.textContent = "Stop";
      stopBtn.addEventListener("click", () =>
        post({
          type: "containerAction",
          action: "stop",
          containerId: c.id,
          containerName: c.name,
        }),
      );
      actions.appendChild(stopBtn);
    }

    const inspectBtn = el("button", "btn small");
    inspectBtn.textContent = "Inspect";
    inspectBtn.addEventListener("click", () =>
      post({
        type: "containerAction",
        action: "inspect",
        containerId: c.id,
        containerName: c.name,
      }),
    );
    actions.appendChild(inspectBtn);

    const removeBtn = el("button", "btn small");
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () =>
      post({
        type: "containerAction",
        action: "remove",
        containerId: c.id,
        containerName: c.name,
      }),
    );
    actions.appendChild(removeBtn);

    if (c.status === "running") {
      const connBtn = el("button", "btn small");
      connBtn.textContent = "Connect";
      connBtn.addEventListener("click", () =>
        post({
          type: "containerAction",
          action: c.localFolder
            ? "connectCurrentWindow"
            : "connectCurrentWindow",
          containerId: c.id,
          containerName: c.name,
        }),
      );
      actions.appendChild(connBtn);
    }

    row.appendChild(top);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

function renderVolumes(volumes) {
  _volumeCount = (volumes || []).length;
  updateStatusBar();
  const list = document.getElementById("volume-list");
  const empty = document.getElementById("volume-empty");
  list.innerHTML = "";
  if (!volumes || volumes.length === 0) {
    if (_volumeFirstLoad) {
      empty.classList.remove("hidden");
    }
    return;
  }
  empty.classList.add("hidden");

  volumes.forEach((v) => {
    const row = el("div", "resource-row");
    const info = el("span", "resource-info");
    info.innerHTML = `<span class="resource-name">${esc(v.name)}</span><span class="resource-meta">${esc(v.driver)}${v.size ? " &middot; " + esc(v.size) : ""}</span>`;
    const actions = el("span", "resource-actions");

    const inspectBtn = el("button", "btn small");
    inspectBtn.textContent = "Inspect";
    inspectBtn.addEventListener("click", () =>
      post({ type: "volumeAction", action: "inspect", volumeName: v.name }),
    );
    actions.appendChild(inspectBtn);

    const removeBtn = el("button", "btn small");
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () =>
      post({ type: "volumeAction", action: "remove", volumeName: v.name }),
    );
    actions.appendChild(removeBtn);

    row.appendChild(info);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function updateStatusBar() {
  const el = document.getElementById("status-bar");
  if (_isRemote) {
    el.textContent = "🔵 Remote";
  } else {
    let parts = ["🟢 Local"];
    if (_containerCount > 0) {
      parts.push(
        `${_containerCount} container${_containerCount > 1 ? "s" : ""}`,
      );
    }
    if (_volumeCount > 0) {
      parts.push(`${_volumeCount} volume${_volumeCount > 1 ? "s" : ""}`);
    }
    el.textContent = parts.join(" · ");
  }
}

function renderCommands(commands) {
  const list = document.getElementById("command-list");
  list.innerHTML = "";
  (commands || []).forEach((c) => {
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
        btn.addEventListener("click", () =>
          post({ type: "runCommand", command: child.id }),
        );
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
      group.addEventListener("mouseleave", () => {
        children.classList.add("hidden");
        chev.textContent = "▶";
      });

      list.appendChild(group);
    } else {
      const row = el("div", "list-row");
      const label = el("span");
      label.textContent = c.label;
      const btn = el("button", "btn small");
      btn.textContent = "Go";
      btn.addEventListener("click", () =>
        post({ type: "runCommand", command: c.id }),
      );
      row.appendChild(label);
      row.appendChild(btn);
      list.appendChild(row);
    }
  });
}

// ── Message handling ──────────────────────────────────────────

function post(msg) {
  vscode.postMessage(msg);
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  switch (msg.type) {
    case "configLoaded":
      toggles = msg.toggles;
      configPath = msg.path;
      showConfigSection(true);
      renderToggles(msg.toggles);
      renderPorts(msg.toggles.forwardPorts);
      renderExtensions(msg.toggles.extensions);
      renderSoftware(msg.software);
      break;
    case "configMissing":
      if (msg.noWorkspace) {
        showNoWorkspace();
      } else if (msg.remote) {
        _isRemote = true;
        updateStatusBar();
        showConfigSection(false);
        document.getElementById("add-config-btn").classList.add("hidden");
        document.getElementById("empty-config-msg").textContent = "";
      } else {
        _isRemote = false;
        showConfigSection(false);
        renderWizardImages();
        document.getElementById("wizard-image-input")?.focus();
      }
      break;
    case "optionToggled":
      if (toggles[msg.feature] !== undefined) {
        toggles[msg.feature] = msg.enabled;
      }
      break;
    case "updateContainers":
      _containerFirstLoad = true;
      renderContainers(msg.containers);
      break;
    case "updateVolumes":
      _volumeFirstLoad = true;
      renderVolumes(msg.volumes);
      break;
    case "expandSection":
      expandAccordionFromHost(msg.section);
      break;
    case "updateCommands":
      renderCommands(msg.commands);
      break;
    case "setInstalledExtensions":
      renderExtensionChecklist(msg.extensions);
      break;
  }
});

// ── Event bindings ────────────────────────────────────────────

document.getElementById("add-port-btn").addEventListener("click", () => {
  const port = parseInt(document.getElementById("port-input").value);
  const label = document.getElementById("port-label-input").value;
  if (port) {
    post({ type: "addPort", port, label });
    document.getElementById("port-input").value = "";
    document.getElementById("port-label-input").value = "";
  }
});

document.getElementById("extension-filter").addEventListener("input", () => {
  if (_allExtensions.length) {
    renderExtensionChecklist(_allExtensions);
  }
});

document.getElementById("extension-filter").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const id = e.target.value.trim();
    if (id && !_allExtensions.some((ext) => ext.id === id)) {
      post({ type: "addExtension", extensionId: id });
      e.target.value = "";
    }
  }
});

document.getElementById("open-config-btn").addEventListener("click", () => {
  post({ type: "action", command: "artizo.openDevContainerFile" });
});

document.getElementById("wizard-generate-btn").addEventListener("click", () => {
  const image = document.getElementById("wizard-image-input").value.trim();
  if (!image) {
    return;
  }
  post({ type: "generateConfig", image });
});

document
  .getElementById("wizard-image-input")
  .addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const image = e.target.value.trim();
      if (!image) {
        return;
      }
      post({ type: "generateConfig", image });
    }
  });

document.querySelectorAll(".refresh-btn").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    post({ type: "refreshSection", section: btn.dataset.section });
  });
});

function renderSoftware(software) {
  const list = document.getElementById("software-list");
  if (!list) return;
  list.innerHTML = "";
  (software || []).forEach((s) => {
    const row = el("label", "software-row");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = s.enabled;
    cb.addEventListener("change", () => {
      post({ type: "toggleSoftware", featureRef: s.ref, enabled: cb.checked });
    });
    row.appendChild(cb);
    row.appendChild(document.createTextNode(s.label));
    list.appendChild(row);
  });
}

document.getElementById("add-software-btn")?.addEventListener("click", () => {
  const input = document.getElementById("software-input");
  const ref = input?.value.trim();
  if (!ref) return;
  post({ type: "toggleSoftware", featureRef: ref, enabled: true });
  input.value = "";
});

post({ type: "ready" });
