export function createInitiative({ dom, isOwner, send, getParticipantNames = () => [] }) {
  let entries = [];
  let turn = 0;

  function applyInitiativeState(state) {
    entries = Array.isArray(state?.entries) ? state.entries.slice().sort((a, b) => Number(b.score || 0) - Number(a.score || 0)) : [];
    turn = Number(state?.turn || 0);
    render();
  }

  function render() {
    renderBanner();
    if (!dom.initiativeList) return;
    dom.initiativeList.replaceChildren();
    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "initiative-empty";
      empty.textContent = isOwner ? "Sem combatentes na ordem." : "Aguardando ordem do mestre.";
      dom.initiativeList.append(empty);
      return;
    }

    entries.forEach((entry, index) => {
      const item = document.createElement("div");
      item.className = "initiative-item";
      if (index === turn) item.classList.add("is-current");

      const marker = document.createElement("span");
      marker.className = "initiative-marker";
      marker.textContent = String(index + 1);

      const name = document.createElement("strong");
      name.textContent = entry.name || "Sem nome";

      const score = document.createElement("b");
      score.textContent = String(entry.score ?? 0);

      item.append(marker, name, score);

      if (isOwner) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "initiative-remove";
        remove.setAttribute("aria-label", `Remover ${entry.name || "item"} da iniciativa`);
        remove.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
        remove.addEventListener("click", () => send("initiative-remove", "", { id: entry.id }));
        item.append(remove);
      }

      dom.initiativeList.append(item);
    });
  }

  function renderBanner() {
    renderTokens(dom.initiativeBanner, true);
    renderTokens(dom.initiativeTokenList, false);
  }

  function renderTokens(container, hideWhenEmpty) {
    if (!container) return;
    container.replaceChildren();
    if (hideWhenEmpty) container.hidden = entries.length === 0;
    if (container === dom.initiativeBanner && dom.initiativePassTop) dom.initiativePassTop.hidden = entries.length === 0;
    if (entries.length === 0) return;

    const normalizedTurn = ((turn % entries.length) + entries.length) % entries.length;
    entries.forEach((entry, index) => {
      const token = document.createElement("span");
      token.className = "initiative-token";
      if (index === normalizedTurn) token.classList.add("is-current");
      token.title = `${entry.name || "Sem nome"} (${entry.score ?? 0})`;
      token.setAttribute("aria-label", `${index === normalizedTurn ? "Turno atual: " : ""}${entry.name || "Sem nome"}, iniciativa ${entry.score ?? 0}`);

      const initials = document.createElement("span");
      initials.className = "initiative-token-initials";
      initials.textContent = initialsForName(entry.name || "");

      const score = document.createElement("b");
      score.textContent = String(entry.score ?? 0);

      token.append(initials, score);
      container.append(token);
    });
  }

  function bindEvents() {
    dom.initiativeName?.addEventListener("focus", renderNameOptions);
    dom.initiativeName?.addEventListener("pointerdown", renderNameOptions);
    dom.initiativeForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = dom.initiativeName?.value.trim() || "";
      const score = Number(dom.initiativeScore?.value);
      if (!name || Number.isNaN(score)) return;
      send("initiative-add", "", { name, score });
      dom.initiativeName.value = "";
      dom.initiativeScore.value = "";
      dom.initiativeName.focus();
    });
    dom.initiativePass?.addEventListener("click", () => send("initiative-pass", "", {}));
    dom.initiativePassTop?.addEventListener("click", () => send("initiative-pass", "", {}));
  }

  function renderNameOptions() {
    if (!dom.initiativeNameOptions) return;
    const currentEntries = new Set(entries.map((entry) => (entry.name || "").toLowerCase()));
    const names = Array.from(new Set(getParticipantNames().map((name) => name.trim()).filter(Boolean)));
    dom.initiativeNameOptions.replaceChildren();
    for (const name of names) {
      if (currentEntries.has(name.toLowerCase())) continue;
      const option = document.createElement("option");
      option.value = name;
      dom.initiativeNameOptions.append(option);
    }
  }

  return { applyInitiativeState, bindEvents };
}

function initialsForName(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return `${parts[0].slice(0, 1)}${parts[parts.length - 1].slice(0, 1)}`.toUpperCase();
}
