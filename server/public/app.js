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
