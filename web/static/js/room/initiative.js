export function createInitiative({ dom, isOwner, send }) {
  let entries = [];
  let turn = 0;

  function applyInitiativeState(state) {
    entries = Array.isArray(state?.entries) ? state.entries : [];
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
    if (!dom.initiativeBanner) return;
    dom.initiativeBanner.replaceChildren();
    dom.initiativeBanner.hidden = entries.length === 0;
    if (entries.length === 0) return;

    const normalizedTurn = ((turn % entries.length) + entries.length) % entries.length;
    const orderedEntries = entries.slice(normalizedTurn).concat(entries.slice(0, normalizedTurn));

    orderedEntries.forEach((entry, index) => {
      const token = document.createElement("span");
      token.className = "initiative-token";
      if (index === 0) token.classList.add("is-current");
      token.title = `${entry.name || "Sem nome"} (${entry.score ?? 0})`;
      token.setAttribute("aria-label", `${index === 0 ? "Turno atual: " : ""}${entry.name || "Sem nome"}, iniciativa ${entry.score ?? 0}`);

      const initials = document.createElement("span");
      initials.className = "initiative-token-initials";
      initials.textContent = initialsForName(entry.name || "");

      const score = document.createElement("b");
      score.textContent = String(entry.score ?? 0);

      token.append(initials, score);
      dom.initiativeBanner.append(token);
    });
  }

  function bindEvents() {
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
  }

  return { applyInitiativeState, bindEvents };
}

function initialsForName(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return `${parts[0].slice(0, 1)}${parts[parts.length - 1].slice(0, 1)}`.toUpperCase();
}
