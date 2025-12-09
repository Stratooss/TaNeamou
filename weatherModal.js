// weatherModal.js
// Απλό custom modal για την πρόγνωση καιρού σε bullets
"use strict";

function hideWeatherModal(modalEl) {
  modalEl.classList.remove("is-visible");
}

function initWeatherModal() {
  const modalEl = document.getElementById("weather-modal");
  if (!modalEl) return;

  const closeButtons = modalEl.querySelectorAll(
    "[data-weather-modal-close]"
  );

  closeButtons.forEach((btn) => {
    btn.addEventListener("click", () => hideWeatherModal(modalEl));
  });

  modalEl.addEventListener("click", (e) => {
    // κλείσιμο όταν κάνεις κλικ έξω από το κουτί ή στο backdrop
    if (
      e.target === modalEl ||
      e.target.classList.contains("weather-modal-backdrop")
    ) {
      hideWeatherModal(modalEl);
    }
  });
}

// forecast = {
//   title: string,
//   bulletForecast: [{ label, emojiSeries }],
//   extraLines: [string]
// }
function openWeatherModal(forecast) {
  const modalEl = document.getElementById("weather-modal");
  const titleEl = document.getElementById("weather-modal-title");
  const bodyEl = document.getElementById("weather-modal-body");

  if (!modalEl || !titleEl || !bodyEl) return;

  const title = forecast && forecast.title
    ? forecast.title
    : "Καιρός σήμερα";

  const bulletForecast = Array.isArray(forecast && forecast.bulletForecast)
    ? forecast.bulletForecast
    : [];

  const extraLines = Array.isArray(forecast && forecast.extraLines)
    ? forecast.extraLines
    : [];

  titleEl.textContent = title;

  const bulletItemsHtml = bulletForecast
    .map((item) => {
      const label = item.label || "";
      const series = item.emojiSeries || "";
      return `
        <li>
          <span class="weather-modal-bullet-label">${label}:</span>
          <span class="weather-modal-bullet-series">${series}</span>
        </li>
      `;
    })
    .join("");

  let html = "";

  if (bulletItemsHtml) {
    html += `
      <ul class="weather-modal-list">
        ${bulletItemsHtml}
      </ul>
    `;
  } else {
    html += `
      <p>Δεν μπορέσαμε να δείξουμε αναλυτική πρόγνωση για σήμερα.</p>
    `;
  }

  if (extraLines.length) {
    html += `
      <div class="weather-modal-extra">
        ${extraLines.map((line) => `<p>${line}</p>`).join("")}
      </div>
    `;
  }

  bodyEl.innerHTML = html;

  modalEl.classList.add("is-visible");
}

// εκθέτουμε τις συναρτήσεις στο window
window.initWeatherModal = initWeatherModal;
window.openWeatherModal = openWeatherModal;
