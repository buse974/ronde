// Formulaire d'une ronde : n'affiche que les champs du déclenchement choisi et
// règle l'alerte par défaut (oui pour une ronde planifiée ou unique, non pour un oneshot)
// tant que l'utilisateur n'a pas touché la case lui-même.
document.documentElement.classList.add('js');
document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('form[data-ronde]');
  if (!form) return;
  const notify = form.querySelector('input[name=notify]');
  let touched = false;
  notify?.addEventListener('change', () => { touched = true; });
  const apply = (fromUser) => {
    const trigger = form.querySelector('input[name=trigger]:checked')?.value ?? 'cron';
    form.querySelectorAll('[data-pour]').forEach((el) => {
      el.toggleAttribute('data-actif', el.dataset.pour.split(' ').includes(trigger));
    });
    if (fromUser && notify && !touched) notify.checked = trigger !== 'oneshot';
  };
  form.querySelectorAll('input[name=trigger]').forEach((r) => r.addEventListener('change', () => apply(true)));
  apply(false);
});

// Conversation longue : on arrive au début de la dernière réponse de Claude.
document.addEventListener('DOMContentLoaded', () => {
  const last = document.getElementById('derniere');
  if (last && !location.hash) last.scrollIntoView({ block: 'start' });
});

// Panneau « Claude » d'une ronde : on montre la fin de la conversation.
document.addEventListener('DOMContentLoaded', () => {
  const fil = document.querySelector('.volet-claude .fil-volet');
  if (fil) fil.scrollTop = fil.scrollHeight;
});

// Main courante : un clic sur un passage déplie sa réponse sous la ligne (le lien de date ouvre toujours le passage).
document.addEventListener('DOMContentLoaded', () => {
  const toggle = (row) => {
    const detail = document.getElementById(row.dataset.detail);
    if (!detail) return;
    const open = detail.hidden;
    detail.hidden = !open;
    row.setAttribute('aria-expanded', String(open));
  };
  document.querySelectorAll('tr.depliable').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('a, button, form')) return;
      if (window.getSelection()?.toString()) return; // sélection de texte : on ne replie pas
      toggle(row);
    });
    row.addEventListener('keydown', (e) => {
      if (e.target !== row || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      toggle(row);
    });
  });
});
