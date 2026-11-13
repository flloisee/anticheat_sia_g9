// Exam detection core, shared by the popup (script tag), the auto-detector content
// script (detect.js) and the background worker (importScripts). sniffExam is passed
// by reference to chrome.scripting.executeScript, so it must stay self-contained and
// only report generic labels, never page text.
// Page signals sniffExam can report, and what each is worth. Reasons are the
// only thing that crosses the frame boundary, so the weights live here.
const SIGNAL_WEIGHTS = {
  'proctoring script': 3,
  'quiz platform': 3,
  'training platform': 2,
  'navigation lock': 2,
  'repeated questions': 2,
  'answer options': 2,
  'question counter': 2,
  'exam heading': 2,
  timer: 2,
  'exam URL': 1,
};

// Runs inside the active page via executeScript, so it must not close over this
// file's scope and it must only report generic labels, never page text.
function sniffExam() {
  try {
    const reasons = [];

    const visible = (el) => {
      try {
        return el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null;
      } catch {
        return false;
      }
    };

    const hosts = /proctoru|proctorio|honorlock|respondus|examity|psiexams|examroom|pearsonvue/i;
    for (const el of document.querySelectorAll('iframe[src], script[src], link[href]')) {
      if (hosts.test(el.src || el.href || '')) {
        reasons.push('proctoring script');
        break;
      }
    }

    if (
      document.querySelector(
        '#page-quiz-attempt, body.quizzes, body.path-mod-quiz, body.path-mod-scorm, body.path-mod-quiz-attempt, form[action*="formResponse"], [id^="question_"]',
      ) ||
      /\/mod\/(?:quiz|scorm)\//.test(location.pathname)
    ) {
      reasons.push('quiz platform');
    }

    // A known certification-training host is a prior, not proof: it is one signal on
    // its own, so a course catalogue page stays quiet.
    const platform =
      /^(?:[^.]*\.)?(netacad\.com|netacad\.net|skillsforall\.com|fortinet\.com|juniper\.net|paloaltonetworks\.com|checkpoint\.com|cybrary\.it|acloudguru\.com|pluralsight\.com|kodekloud\.com|coursera\.org|udemy\.com|edx\.org|offsec\.com|isc2\.org|certiport\.com|pearsonvue\.com|prometric\.com|psiexams\.com|testout\.com|comptia\.org)$/i.test(
        location.hostname,
      );
    if (platform) reasons.push('training platform');

    const locked =
      Boolean(document.onbeforeunload) ||
      Boolean(document.body?.hasAttribute('onbeforeunload')) ||
      document.documentElement.hasAttribute('onbeforeunload') ||
      Boolean(document.fullscreenElement);
    if (locked) reasons.push('navigation lock');

    if (document.forms.length >= 1) {
      const boxes = [...document.querySelectorAll('input[type=radio], input[type=checkbox]')].filter(
        visible,
      );
      if (boxes.length >= 10) {
        const groups = new Map();
        for (const box of boxes) {
          const container = box.closest('fieldset, li, [class*=question]') ?? box.parentElement;
          const key = container?.className || container?.tagName;
          if (key) groups.set(key, (groups.get(key) ?? 0) + 1);
        }
        for (const size of groups.values()) {
          if (size >= 3) {
            reasons.push('repeated questions');
            break;
          }
        }
      }
    }

    const text = (document.body?.textContent ?? '').slice(0, 50000);
    const timer = /(?:^|\s)\d{1,2}:\d{2}(?::\d{2})?(?=\s|$)/.test(text);
    if (timer) reasons.push('timer');

    const counter =
      /\b(?:question|q)\s*\d{1,3}\s*(?:of|\/)\s*\d{1,3}\b|\b\d{1,3}\s+of\s+\d{1,3}\s+questions?\b/i.test(
        text,
      );
    if (counter) reasons.push('question counter');

    // SCORM SCOs often have no <form>, so count controls directly. Dropdowns count too.
    const controls = [
      ...document.querySelectorAll('input[type=radio], input[type=checkbox], select'),
    ].filter(visible).length;
    if (
      controls >= 3 &&
      /\bquestion\s*\d|\bchoose\s+(?:one|two|three|four|all|the|an?)\b|\bselect\s+(?:one|two|all|the|an?)\b/i.test(
        text,
      )
    ) {
      reasons.push('answer options');
    }

    // A training host's sidebar lists its quiz section on every page, so the wording
    // is only trusted in the title, in a real heading, or when the body names a
    // question ("Question 1"); a module page has neither.
    const heading =
      /\b(?:quiz(?:zes)?|exam|assessment|knowledge check|practice test|certification exam)\b/i;
    const numbered = /\b(?:question|q)\s*\d{1,3}\b/i.test(text);
    const heads = [...document.querySelectorAll('h1, h2, h3, h4, legend, [role=heading]')].slice(
      0,
      200,
    );
    if (
      numbered ||
      heading.test(document.title) ||
      heading.test(heads.map((el) => el.textContent).join(' '))
    ) {
      reasons.push('exam heading');
    }

    // A training-host URL can contain "certif" on any page, so it needs question shape.
    const here = location.pathname + location.search;
    if (
      (controls >= 3 || counter || timer || numbered) &&
      /\b(?:exam|assessment|quiz|test|final|certif)\w*/i.test(here)
    ) {
      reasons.push('exam URL');
    }

    // Practice material is not an exam: drop the contextual signals instead of
    // letting them be subtracted, because a frame reports labels, not scores.
    if (/practice|sample|demo|pretest|guide|faq|help/i.test(`${here} ${document.title}`)) {
      const contextual = ['exam URL', 'exam heading', 'training platform'];
      return { reasons: reasons.filter((reason) => !contextual.includes(reason)) };
    }

    return { reasons };
  } catch {
    return { reasons: [] };
  }
}
