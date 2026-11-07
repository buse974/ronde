import nodemailer from 'nodemailer';

const STATUS_LABEL = { alert: 'Alerte', failed: 'Échec' };

export function createMailer(config, { transport } = {}) {
  const smtp = config.smtp;
  const transporter =
    transport ??
    (smtp.host
      ? nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.secure,
          auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
          tls: { rejectUnauthorized: smtp.rejectUnauthorized },
        })
      : null);

  return {
    enabled: !!transporter,

    /** Envoie l'alerte d'un run en « alert » ou « failed ». Retourne true si envoyé. */
    async sendRunAlert({ to, task, run }) {
      if (!transporter || !to) return false;
      const label = STATUS_LABEL[run.status] ?? run.status;
      const link = config.publicUrl ? `${config.publicUrl}/runs/${run.id}` : null;
      const body =
        run.status === 'failed'
          ? [`Le run #${run.id} de la tâche « ${task.name} » a échoué.`, '', run.error ?? '', run.result ? `\nRéponse :\n${run.result}` : '', run.stderr ? `\nstderr :\n${run.stderr.slice(-2000)}` : '']
          : [
              `Claude signale un problème pour la tâche « ${task.name} » (run #${run.id}) :`,
              '',
              run.result || '(Claude n’a renvoyé aucun texte : voir le détail du run, par exemple une limite de tours atteinte.)',
            ];
      if (link) body.push('', `Détail : ${link}`);

      await transporter.sendMail({
        from: config.smtp.from,
        to,
        subject: `[ronde] ${label} : ${task.name}`,
        text: body.join('\n'),
      });
      return true;
    },

    async sendTest(to) {
      if (!transporter) throw new Error('SMTP non configuré (SMTP_HOST).');
      await transporter.sendMail({
        from: config.smtp.from,
        to,
        subject: '[ronde] Mail de test',
        text: 'Les alertes ronde arriveront à cette adresse.',
      });
    },
  };
}
