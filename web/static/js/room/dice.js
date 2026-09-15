export function createDice({ dom, send }) {
  function sendDiceRoll() {
    const count = Number(dom.diceCount?.value || 1);
    const sides = Number(dom.diceSides?.value || 20);
    const modifier = Number(dom.diceModifier?.value || 0);
    send("dice-roll", "", { count, sides, modifier });
  }

  function renderDiceResult(roll) {
    if (!dom.diceLog || !roll) return;
    showDiceToast(roll);
    const item = document.createElement("div");
    item.className = "dice-result";
    const header = document.createElement("div");
    header.className = "dice-result-header";
    const roller = document.createElement("strong");
    roller.textContent = roll.roller || "Jogador";
    const expression = document.createElement("span");
    expression.textContent = roll.expression || "";
    const total = document.createElement("b");
    total.textContent = String(roll.total ?? "");
    header.append(roller, expression, total);
    const details = document.createElement("p");
    const rolls = Array.isArray(roll.rolls) ? roll.rolls.join(", ") : "";
    const modifier = Number(roll.modifier || 0);
    details.textContent = modifier === 0 ? `[${rolls}]` : `[${rolls}] ${modifier > 0 ? "+" : ""}${modifier}`;
    item.append(header, details);
    dom.diceLog.prepend(item);
    while (dom.diceLog.children.length > 6) dom.diceLog.lastElementChild.remove();
  }

  function showDiceToast(roll) {
    if (!dom.diceToastLayer || !roll) return;
    const toast = document.createElement("div");
    toast.className = "dice-toast";
    const icon = document.createElement("span");
    icon.className = "dice-toast-icon";
    icon.innerHTML = '<i class="fa-solid fa-dice-d20" aria-hidden="true"></i>';
    const body = document.createElement("div");
    body.className = "dice-toast-body";
    const title = document.createElement("strong");
    title.textContent = `${roll.roller || "Jogador"} rolou ${roll.expression || ""}`;
    const detail = document.createElement("span");
    const rolls = Array.isArray(roll.rolls) ? roll.rolls.join(" + ") : "";
    const modifier = Number(roll.modifier || 0);
    detail.textContent = modifier === 0 ? rolls : `${rolls} ${modifier > 0 ? "+" : "-"} ${Math.abs(modifier)}`;
    body.append(title, detail);
    const total = document.createElement("b");
    total.textContent = String(roll.total ?? "");
    toast.append(icon, body, total);
    dom.diceToastLayer.replaceChildren(toast);
    setTimeout(() => {
      if (toast.parentElement === dom.diceToastLayer) toast.remove();
    }, 3600);
  }

  function renderDiceError(message) {
    if (!dom.diceLog) return;
    const item = document.createElement("div");
    item.className = "dice-result is-error";
    item.textContent = message;
    dom.diceLog.prepend(item);
  }

  function bindEvents() {
    dom.diceForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      sendDiceRoll();
    });
  }

  return { bindEvents, renderDiceResult, renderDiceError };
}

