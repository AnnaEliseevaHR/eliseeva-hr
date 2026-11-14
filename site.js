(()=>{
  'use strict';
  const menuButton=document.querySelector('[data-menu-button]');
  const menu=document.querySelector('[data-menu]');
  if(menu&&menuButton){
    const openLabel=menuButton.getAttribute('aria-label');
    const setMenuOpen=open=>{
      menuButton.setAttribute('aria-expanded',String(open));
      menuButton.setAttribute('aria-label',open?menuButton.dataset.closeLabel:openLabel);
      menu.classList.toggle('open',open);
    };
    menuButton.addEventListener('click',()=>{
      setMenuOpen(menuButton.getAttribute('aria-expanded')!=='true');
    });
    document.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&menuButton.getAttribute('aria-expanded')==='true'){
        setMenuOpen(false);
        menuButton.focus();
      }
    });
    menu.addEventListener('click',event=>{
      if(event.target.closest('a'))setMenuOpen(false);
    });
  }
  document.querySelectorAll('[data-year]').forEach(e=>e.textContent=String(new Date().getFullYear()));
  const email=(document.querySelector('meta[name="contact-email"]')?.content||'').trim();
  const emailText=document.querySelector('[data-email-text]');
  const copyEmail=document.querySelector('[data-copy-email]');
  if(copyEmail&&email){
    const copyLabel=copyEmail.textContent;
    let resetLabel;
    copyEmail.addEventListener('click',async()=>{
      try{
        await navigator.clipboard.writeText(email);
        copyEmail.textContent=copyEmail.dataset.copied||'Copied';
        clearTimeout(resetLabel);
        resetLabel=setTimeout(()=>copyEmail.textContent=copyLabel,1700);
      }catch{
        if(!emailText)return;
        emailText.focus();
        const range=document.createRange();
        range.selectNodeContents(emailText);
        const selection=window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
    });
  }
  const form = document.querySelector('[data-contact-form]');
  if (!form) return;
  if (location.protocol === 'file:') {
    document.querySelector('[data-local-form-note]').hidden = false;
    return;
  }

  const isEnglish = document.documentElement.lang === 'en';
  const status = form.querySelector('[data-form-status]');
  const submit = form.querySelector('button[type=submit]');
  const topic = form.elements.topic;
  const languageLink = document.querySelector('.lang');
  const requestedTopic = new URLSearchParams(location.search).get('topic');
  if (Array.from(topic.options).some(option => option.value === requestedTopic)) {
    topic.value = requestedTopic;
  }
  const updateLanguageLink = () => {
    const target = new URL(languageLink.href);
    target.searchParams.set('topic', topic.value);
    languageLink.href = target.href;
  };
  updateLanguageLink();
  topic.addEventListener('change', updateLanguageLink);

  const labels = isEnglish ? {
    sending: 'Sending…',
    received: 'Enquiry received. Thank you!',
    failed: 'Unable to confirm receipt. Try again or contact Anna by email.',
    limited: 'Too many attempts. Wait a minute and try again.',
    invalid: 'Check that your name, contact details and message contain enough text.',
  } : {
    sending: 'Отправляем…',
    received: 'Заявка получена. Спасибо!',
    failed: 'Подтвердить приём заявки не удалось. Повторите попытку или напишите Анне на email.',
    limited: 'Слишком много попыток. Подождите минуту и попробуйте снова.',
    invalid: 'Проверьте имя, контакт для ответа и длину сообщения.',
  };
  let pending = false;
  let previousBody;
  let requestId;
  form.addEventListener('input', () => {
    if (!pending) status.textContent = '';
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending || !form.reportValidity()) return;
    const fields = JSON.stringify(Object.fromEntries(new FormData(form)));
    const data = JSON.parse(fields);
    data.consent = data.consent === 'on';
    data.lang = document.documentElement.lang;
    const body = JSON.stringify(data);
    if (body !== previousBody) {
      requestId = crypto.randomUUID();
      previousBody = body;
    }
    pending = true;
    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
    status.textContent = labels.sending;
    try {
      const response = await fetch('/api/enquiries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, id: requestId }),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok && (await response.json()).received === true) {
        if (JSON.stringify(Object.fromEntries(new FormData(form))) === fields) {
          const selectedTopic = topic.value;
          form.reset();
          topic.value = selectedTopic;
        }
        previousBody = undefined;
        status.textContent = labels.received;
      } else {
        status.textContent = response.status === 429 ? labels.limited
          : response.status === 400 ? labels.invalid : labels.failed;
      }
    } catch {
      status.textContent = labels.failed;
    } finally {
      pending = false;
      submit.disabled = false;
      form.removeAttribute('aria-busy');
    }
  });
  form.hidden = false;
})();
