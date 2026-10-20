(() => {
  "use strict";

  if (document.getElementById("edgy-widget")) return;

  const faqs = [
    {
      category: "Courses and classes",
      keywords: ["classes", "class", "teach", "grade", "course", "program", "programme", "offer", "available", "ix", "xii"],
      answer: "Mentora Edge offers programs for Classes IX, X, XI and XII. Classes IX and X have English, Social Science, Science and Mathematics. Classes XI and XII have English only.",
      links: [{ label: "View Programs", href: "programs.html" }]
    },
    {
      category: "Subjects offered",
      keywords: ["subject", "subjects", "math", "maths", "mathematics", "science", "social science", "english", "what do", "study"],
      answer: "Classes IX and X: English, Social Science, Science and Mathematics. Classes XI and XII: English only.",
      links: [{ label: "View Programs", href: "programs.html" }]
    },
    {
      category: "Fee structure and payment plans",
      keywords: ["fee", "fees", "cost", "price", "pricing", "payment", "pay", "monthly", "quarterly", "annual", "year", "installment", "installment"],
      answer: "Classes IX-X individual subjects: English \u20B9500/month, Social Science \u20B9500/month, Science \u20B9600/month and Mathematics \u20B9600/month. The all-four-subject combo is \u20B92,200/month, or quarterly installments of \u20B97,000 + \u20B97,000 + \u20B96,000 = \u20B920,000 total. The annual combo is \u20B926,400 standard, reduced to \u20B920,000 with the \u20B96,400 upfront-payment discount. Classes XI-XII English is \u20B95,000/year, annual payment only.",
      links: [{ label: "Programs and fees", href: "programs.html" }]
    },
    {
      category: "Discounts and payment options",
      keywords: ["discount", "discounts", "save", "saving", "option", "options", "plan", "plans", "installment", "installments", "refund", "refundable", "transfer"],
      answer: "The ₹20,000 one-time annual payment for the Classes IX-X all-subject combo includes a ₹6,400 discount from its ₹26,400 annual value. Quarterly combo installments are ₹7,000 + ₹7,000 + ₹6,000. Monthly individual subject plans are also listed for Classes IX-X. Classes XI-XII English is annual-payment only. Fees are non-refundable and non-transferable.",
      links: [{ label: "Programs and fees", href: "programs.html" }]
    },
    {
      category: "Admissions and registration",
      keywords: ["admission", "admissions", "register", "registration", "enroll", "enrol", "join", "sign up", "apply", "start"],
      answer: "You can begin by submitting the website enquiry form. To select a listed program, visit the Programs page and use its registration link. The institute can confirm availability and next steps.",
      links: [{ label: "Book an enquiry", href: "enquiry.html" }, { label: "Registration", href: "register.html" }]
    },
    {
      category: "Educator profiles",
      keywords: ["educator", "educators", "teacher", "teachers", "faculty", "who teaches", "profile", "profiles"],
      answer: "The Educators page lists Ranita Munshi, founding English educator, and Subir Munshi, founding Social Science educator. Visit the page for their profiles and teaching information.",
      links: [{ label: "Meet the educators", href: "educators.html" }]
    },
    {
      category: "Leadership",
      keywords: ["ceo of mentora edge", "mentora edge ceo", "what is the name of the ceo", "what is the name of ceo", "founded mentora edge", "founder of mentora edge", "mentora edge founder", "runs mentora edge"],
      answer: "Abir Munshi is the Founder & CEO of Mentora Edge."
    },
    {
      category: "Institute information",
      keywords: ["about", "institute", "center", "centre", "mentora edge", "information", "location", "address", "where", "begusarai"],
      answer: "Mentora Edge offers CBSE learning for Classes IX-XII, including offline coaching in Begusarai and online personal tuition. The listed address is Suhird Nagar, Opposite Circuit House, Begusarai, Bihar.",
      links: [{ label: "About Mentora Edge", href: "about.html" }, { label: "Contact", href: "enquiry.html" }]
    },
    {
      category: "Contact details",
      keywords: ["contact", "phone", "call", "email", "reach", "talk", "message", "number", "map"],
      answer: "You can contact Mentora Edge at mentoraedge@gmail.com or +91 80570 81826, or use the enquiry page. The listed address is Suhird Nagar, Opposite Circuit House, Begusarai, Bihar.",
      links: [{ label: "Contact and enquiry", href: "enquiry.html" }, { label: "Email Mentora Edge", href: "mailto:mentoraedge@gmail.com" }, { label: "Call Mentora Edge", href: "tel:+918057081826" }]
    }
  ];

  const suggestions = [
    "Which classes do you teach?",
    "What are the fees?",
    "How do I register?",
    "Who are the educators?",
    "How can I contact Mentora Edge?"
  ];
  const otherProviders = ["pw", "physics wallah", "allen", "aakash", "vedantu", "unacademy", "fiitjee", "resonance"];

  const root = document.createElement("section");
  root.id = "edgy-widget";
  root.className = "edgy-widget";
  root.setAttribute("aria-label", "Edgy chat assistant");
  root.innerHTML = `
    <button class="edgy-launcher" type="button" aria-label="Open chat with Edgy" aria-expanded="false" aria-controls="edgy-panel">
      <span class="edgy-launcher-face" aria-hidden="true"><span></span><span></span><i></i></span>
      <span class="edgy-launcher-label">Ask Edgy</span>
    </button>
    <section class="edgy-panel" id="edgy-panel" role="dialog" aria-modal="false" aria-labelledby="edgy-title" aria-hidden="true" inert>
      <header class="edgy-header">
        <span class="edgy-avatar" aria-hidden="true"><span></span><span></span><i></i></span>
        <div class="edgy-heading"><strong id="edgy-title">Edgy</strong><span>Mentora Edge assistant</span></div>
        <button class="edgy-close" type="button" aria-label="Close chat">×</button>
      </header>
      <div class="edgy-messages" aria-live="polite" aria-relevant="additions text"></div>
      <form class="edgy-form">
        <label class="edgy-sr-only" for="edgy-input">Message Edgy</label>
        <input id="edgy-input" name="message" type="text" maxlength="500" autocomplete="off" placeholder="Ask a question…" required>
        <button class="edgy-send" type="submit" aria-label="Send message"><span aria-hidden="true">↑</span></button>
      </form>
      <p class="edgy-note">Please don’t share passwords or private student or payment information.</p>
    </section>`;
  document.body.append(root);

  const launcher = root.querySelector(".edgy-launcher");
  const panel = root.querySelector(".edgy-panel");
  const close = root.querySelector(".edgy-close");
  const messages = root.querySelector(".edgy-messages");
  const form = root.querySelector(".edgy-form");
  const input = root.querySelector(".edgy-form input");
  let busy = false;

  function addMessage(text, role, links = []) {
    const bubble = document.createElement("div");
    bubble.className = `edgy-message edgy-${role}`;
    bubble.textContent = text;
    messages.append(bubble);
    if (links.length) {
      const linkRow = document.createElement("div");
      linkRow.className = "edgy-links";
      links.forEach(({ label, href }) => {
        const link = document.createElement("a");
        link.textContent = label;
        link.href = href;
        linkRow.append(link);
      });
      messages.append(linkRow);
    }
    messages.scrollTop = messages.scrollHeight;
  }

  function normalize(text) {
    return text.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  }

  function findAnswer(question) {
    const normalized = normalize(question);
    if (otherProviders.some(provider => {
      const providerPattern = provider === "pw" ? /(^|\s)pw(\s|$)/ : new RegExp(`(^|\\s)${provider}(\\s|$)`, "i");
      return providerPattern.test(normalized);
    })) return null;

    const feeIntent = /\b(fees?|cost|price|pricing|payment|pay|tuition)\b/.test(normalized);
    if (feeIntent) {
      const feeLink = [{ label: "Programs and Fees", href: "programs.html" }];
      const hasCombo = /\b(combo|all four|all subject|all subjects)\b/.test(normalized);
      const classMatch = normalized.match(/\b(?:class\s+)?(ix|xii|xi|x)\b/);
      const className = classMatch?.[1]?.toUpperCase() || "";
      const isSecondary = className === "IX" || className === "X";
      const isSenior = className === "XI" || className === "XII";
      const isQuarterly = /\b(quarter|quarterly|installments?|instalments?)\b/.test(normalized);
      const isAnnual = /\b(annual|annually|yearly|upfront|year)\b/.test(normalized);
      const isMonthly = /\b(month|monthly)\b/.test(normalized);

      if (hasCombo && isQuarterly) {
        return {
          category: "Fee structure and payment plans",
          answer: "The quarterly all-four-subject combo is \u20B97,000 + \u20B97,000 + \u20B96,000 = \u20B920,000 total.",
          links: feeLink
        };
      }
      if (hasCombo && isAnnual) {
        return {
          category: "Fee structure and payment plans",
          answer: "The all-four-subject annual combo costs \u20B920,000 when paid upfront, after the \u20B96,400 discount from the standard \u20B926,400 annual total.",
          links: feeLink
        };
      }
      if (hasCombo && isMonthly) {
        return {
          category: "Fee structure and payment plans",
          answer: "The all-four-subject combo costs \u20B92,200 per month.",
          links: feeLink
        };
      }

      const subject = /\bsocial science\b/.test(normalized) ? "Social Science"
        : /\bscience\b/.test(normalized) ? "Science"
        : /\benglish\b/.test(normalized) ? "English"
        : /\b(math|maths|mathematics)\b/.test(normalized) ? "Mathematics"
        : "";
      if (!hasCombo && subject && (isSecondary || isSenior)) {
        if (isSenior && subject === "English") {
          return {
            category: "Fee structure and payment plans",
            answer: `Class ${className} English costs \u20B95,000 per year, with annual payment only. See the Programs and Fees page for all plans.`,
            links: feeLink
          };
        }
        if (isSecondary) {
          const amount = subject === "Science" || subject === "Mathematics" ? 600 : 500;
          return {
            category: "Fee structure and payment plans",
            answer: `Class ${className} ${subject} costs \u20B9${amount} per month. See the Programs and Fees page for all plans.`,
            links: feeLink
          };
        }
      }

      if (/\b(all|show|list|full|every)\b/.test(normalized) && /\b(fees?|prices?|pricing|costs?)\b/.test(normalized)) {
        return { ...faqs.find(faq => faq.category === "Fee structure and payment plans"), links: feeLink };
      }

      return {
        category: "Fee structure and payment plans",
        answer: "Classes IX-X individual subjects cost \u20B9500-\u20B9600 per month. The all-subject combo is \u20B92,200/month, \u20B920,000 total by quarterly installments, or \u20B920,000 upfront annually after a \u20B96,400 discount. Classes XI-XII English costs \u20B95,000/year, annual payment only.",
        links: feeLink
      };
    }

    const words = new Set(normalized.split(" ").filter(word => word.length > 1));
    let best = null;
    let bestScore = 0;
    for (const faq of faqs) {
      let score = 0;
      for (const keyword of faq.keywords) {
        const key = normalize(keyword);
        if (key.includes(" ") ? normalized.includes(key) : words.has(key)) score += key.includes(" ") ? 3 : 1;
      }
      if (score > bestScore) { best = faq; bestScore = score; }
    }
    return bestScore >= 1 ? best : null;
  }

  function addSuggestions() {
    const wrap = document.createElement("div");
    wrap.className = "edgy-suggestions";
    suggestions.forEach(question => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = question;
      button.addEventListener("click", () => submitQuestion(question));
      wrap.append(button);
    });
    messages.append(wrap);
  }

  function openPanel() {
    panel.inert = false;
    panel.setAttribute("aria-hidden", "false");
    root.classList.add("edgy-open");
    launcher.setAttribute("aria-expanded", "true");
    if (!messages.childElementCount) {
      addMessage("Hey there! 👋 I'm Edgy, your Mentora Edge assistant. What can I help you with today?", "bot");
      addSuggestions();
    }
    input.focus();
  }

  function closePanel() {
    panel.inert = true;
    panel.setAttribute("aria-hidden", "true");
    root.classList.remove("edgy-open");
    launcher.setAttribute("aria-expanded", "false");
    launcher.focus();
  }

  function submitQuestion(question) {
    const clean = question.trim().slice(0, 500);
    if (!clean || busy) return;
    busy = true;
    input.disabled = true;
    addMessage(clean, "visitor");
    const answer = findAnswer(clean);
    if (answer) {
      addMessage(answer.answer, "bot", answer.links);
    } else {
      addMessage("I can help with Mentora Edge's courses and fees. For details about another institute, please check their official website. For Mentora Edge questions, please contact the institute so you get an accurate answer.", "bot", [
        { label: "Contact Mentora Edge", href: "enquiry.html" },
        { label: "Email", href: "mailto:mentoraedge@gmail.com" }
      ]);
    }
    busy = false;
    input.disabled = false;
    input.value = "";
    input.focus();
  }

  launcher.addEventListener("click", openPanel);
  close.addEventListener("click", closePanel);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && root.classList.contains("edgy-open")) closePanel();
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    submitQuestion(input.value);
  });
})();
