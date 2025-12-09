// weatherWidget.js
// Widget καιρού σε απλά ελληνικά, με 4 σύντομες προτάσεις.

"use strict";

// ===== Βοηθητικές συναρτήσεις για καιρό =====

function mapWeatherToIconAndSky(code, isNight) {
  // Νύχτα: δείξε φεγγάρι όταν ο ουρανός είναι καθαρός ή λίγο συννεφιασμένος
  if (isNight && [0, 1, 2, 3].includes(code)) {
    if (code === 0) {
      return { icon: "🌙", sky: "καθαρός" };
    }
    return { icon: "🌙", sky: "με λίγα σύννεφα" };
  }

  if (code === 0) {
    return { icon: "☀️", sky: "καθαρός" };
  }
  if (code === 1 || code === 2 || code === 3) {
    return { icon: "⛅", sky: "με λίγα σύννεφα" };
  }
  if (code === 45 || code === 48) {
    return { icon: "🌫️", sky: "με ομίχλη" };
  }
  if ([51, 53, 55, 56, 57].includes(code)) {
    return { icon: "🌦️", sky: "με ψιλή βροχή" };
  }
  if ([61, 63, 65, 80, 81, 82].includes(code)) {
    return { icon: "🌧️", sky: "με βροχή" };
  }
  if ([71, 73, 75, 77, 85, 86].includes(code)) {
    return { icon: "🌨️", sky: "με χιόνι" };
  }
  if ([95, 96, 99].includes(code)) {
    return { icon: "⛈️", sky: "με καταιγίδα" };
  }
  return { icon: "🌈", sky: "άγνωστος" };
}

// υπολογίζει τη μέγιστη πιθανότητα βροχής στις επόμενες ώρες
function getFutureRainProbability(data) {
  const hourly = data && data.hourly;
  if (
    !hourly ||
    !Array.isArray(hourly.time) ||
    !Array.isArray(hourly.precipitation_probability)
  ) {
    return null;
  }

  const now = new Date();
  const times = hourly.time;
  const probs = hourly.precipitation_probability;

  let maxProb = 0;

  for (let i = 0; i < times.length; i++) {
    const t = new Date(times[i]);
    if (t <= now) continue;
    const hoursDiff = (t - now) / (1000 * 60 * 60);
    // Κοιτάμε περίπου τις επόμενες 12 ώρες
    if (hoursDiff < 0 || hoursDiff > 12) continue;

    const p = typeof probs[i] === "number" ? probs[i] : Number(probs[i]);
    if (!isNaN(p) && p > maxProb) {
      maxProb = p;
    }
  }

  return maxProb;
}

// Πρόταση για τα ρούχα, με βάση τη θερμοκρασία
function getClothingSentence(tempValue) {
  if (typeof tempValue !== "number" || isNaN(tempValue)) {
    return "Βάλε ρούχα που σε κάνουν να νιώθεις άνετα.";
  }
  if (tempValue <= 5) {
    return "Θα χρειαστείς χοντρό μπουφάν.";
  }
  if (tempValue <= 15) {
    return "Θα χρειαστείς ζεστή ζακέτα.";
  }
  if (tempValue <= 25) {
    return "Θα νιώθεις καλά με μια ζακέτα.";
  }
  return "Θα νιώθεις καλά με ελαφριά ρούχα.";
}

// Πρόταση για τη βροχή αργότερα σήμερα
function getFutureRainSentence(futureMaxProb, rainingNow) {
  if (futureMaxProb == null) {
    return "Δεν ξέρουμε αν θα βρέξει αργότερα.";
  }

  if (futureMaxProb >= 60) {
    return rainingNow
      ? "Θα συνεχίσει να βρέχει και αργότερα."
      : "Αργότερα σήμερα θα βρέξει.";
  }

  if (futureMaxProb >= 30) {
    return "Μπορεί να βρέξει και αργότερα.";
  }

  if (rainingNow) {
    return "Αργότερα σήμερα η βροχή μάλλον θα σταματήσει.";
  }

  return "Μάλλον δεν θα βρέξει αργότερα.";
}

// Πρόταση για την ομπρέλα
function getUmbrellaSentence(futureMaxProb, rainingNow) {
  if (rainingNow) {
    return "Αν βγεις έξω, πάρε ομπρέλα.";
  }

  if (futureMaxProb == null) {
    return "Αν φοβάσαι μήπως βρέξει, μπορείς να πάρεις μια ομπρέλα.";
  }

  if (futureMaxProb >= 40) {
    return "Αν βγεις έξω, καλό είναι να πάρεις ομπρέλα.";
  }

  return "Η ομπρέλα μάλλον δεν χρειάζεται σήμερα.";
}

// ===== Γεωεντοπισμός χρήστη =====

// 1️⃣ browser geolocation
async function getLocationFromBrowser() {
  if (!("geolocation" in navigator)) {
    return null;
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          city: null,
        });
      },
      (err) => {
        console.warn("Geolocation error:", err);
        resolve(null);
      },
      {
        enableHighAccuracy: false,
        timeout: 7000,
        maximumAge: 10 * 60 * 1000,
      }
    );
  });
}

// 2️⃣ IP geolocation
async function getLocationFromIp() {
  try {
    const res = await fetch("https://ipapi.co/json/");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (
      data &&
      typeof data.latitude === "number" &&
      typeof data.longitude === "number"
    ) {
      return {
        lat: data.latitude,
        lon: data.longitude,
        city: data.city || null,
      };
    }
  } catch (err) {
    console.error("IP geolocation failed:", err);
  }
  return null;
}

// 3️⃣ Επιλογή τελικής τοποθεσίας χρήστη
async function resolveUserLocation() {
  const browserLoc = await getLocationFromBrowser();
  if (browserLoc) return browserLoc;

  const ipLoc = await getLocationFromIp();
  if (ipLoc) return ipLoc;

  // Fallback: Αθήνα
  return {
    lat: 37.98,
    lon: 23.72,
    city: "Αθήνα",
  };
}

// ===== Κύρια συνάρτηση widget =====

async function initWeatherWidget() {
  const iconEl = document.getElementById("weather-icon");
  const mainEl = document.getElementById("weather-text");
  const subEl = document.getElementById("weather-subtext");
  const adviceEl = document.getElementById("weather-advice");

  if (!iconEl || !mainEl) return;

  mainEl.textContent = "Φορτώνω τον καιρό…";
  if (subEl) subEl.textContent = "";
  if (adviceEl) adviceEl.textContent = "";

  try {
    const loc = await resolveUserLocation();
    const now = new Date();
    const hour = now.getHours();
    const isNight = hour < 6 || hour >= 20;

    const url =
      "https://api.open-meteo.com/v1/forecast" +
      "?latitude=" +
      loc.lat +
      "&longitude=" +
      loc.lon +
      "&current=temperature_2m,apparent_temperature,weather_code,precipitation" +
      "&hourly=precipitation_probability" +
      "&timezone=auto";

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error("HTTP " + res.status);
    }

    const data = await res.json();
    const current = data && data.current;
    if (!current) {
      throw new Error("Χωρίς current weather στο API.");
    }

    const code = current.weather_code;
    const temp =
      typeof current.apparent_temperature === "number"
        ? current.apparent_temperature
        : current.temperature_2m;
    const precipNow = current.precipitation;

    const { icon, sky } = mapWeatherToIconAndSky(code, isNight);
    const futureMaxProb = getFutureRainProbability(data);
    const tempValue =
      typeof temp === "number" && !isNaN(temp) ? temp : null;
    const rainingNow =
      typeof precipNow === "number" && !isNaN(precipNow) && precipNow > 0.1;

    iconEl.textContent = icon;

    // 1️⃣ ΠΡΩΤΗ ΠΡΟΤΑΣΗ: Τι γίνεται ΤΩΡΑ
    let firstSentence;
    const isStorm = [95, 96, 99].includes(code);
    const isRain = [61, 63, 65, 80, 81, 82].includes(code);
    const isDrizzle = [51, 53, 55, 56, 57].includes(code);
    const isSnow = [71, 73, 75, 77, 85, 86].includes(code);

    if (isStorm) {
      firstSentence = "Τώρα στην περιοχή σου έχει καταιγίδα.";
    } else if (isSnow) {
      firstSentence = "Τώρα στην περιοχή σου χιονίζει.";
    } else if (isRain) {
      firstSentence = "Τώρα στην περιοχή σου βρέχει.";
    } else if (isDrizzle) {
      firstSentence = "Τώρα στην περιοχή σου ψιχαλίζει.";
    } else if (code === 0 && isNight) {
      firstSentence = "Τώρα στην περιοχή σου έχει ξαστεριά.";
    } else if (code === 0) {
      firstSentence = "Τώρα στην περιοχή σου έχει ήλιο.";
    } else if ([1, 2, 3].includes(code) && isNight) {
      firstSentence = "Τώρα στην περιοχή σου έχει λίγα σύννεφα το βράδυ.";
    } else if ([1, 2, 3].includes(code)) {
      firstSentence = "Τώρα στην περιοχή σου έχει λίγα σύννεφα.";
    } else {
      firstSentence =
        "Τώρα στην περιοχή σου ο ουρανός είναι " + sky + ".";
    }

    // 2️⃣ ΔΕΥΤΕΡΗ ΠΡΟΤΑΣΗ: Τι γίνεται ΑΡΓΟΤΕΡΑ
    const secondSentence = getFutureRainSentence(
      futureMaxProb,
      rainingNow
    );

    // 3️⃣ ΤΡΙΤΗ ΠΡΟΤΑΣΗ: Ρούχα
    const thirdSentence = getClothingSentence(tempValue);

    // 4️⃣ ΤΕΤΑΡΤΗ ΠΡΟΤΑΣΗ: Ομπρέλα
    const fourthSentence = getUmbrellaSentence(
      futureMaxProb,
      rainingNow
    );

    // 🔚 Γράφουμε τα κείμενα στο widget
    mainEl.textContent = firstSentence;
    if (subEl) {
      subEl.textContent = secondSentence;
    }
    if (adviceEl) {
      adviceEl.textContent = thirdSentence + " " + fourthSentence;
    }
  } catch (err) {
    console.error(err);
    iconEl.textContent = "";
    mainEl.textContent = "Δεν μπορώ να δείξω τον καιρό αυτή τη στιγμή.";
    if (subEl) {
      subEl.textContent = "Προσπάθησε ξανά αργότερα.";
    }
    if (adviceEl) {
      adviceEl.textContent = "";
    }
  }
}

// κάνουμε την init διαθέσιμη στο window
window.initWeatherWidget = initWeatherWidget;

