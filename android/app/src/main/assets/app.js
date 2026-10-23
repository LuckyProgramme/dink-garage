const $ = id => document.getElementById(id);
let view = 'welcome', state = {}, emails = [], formError = '', enrollmentPrompted = false, lastTestToken = '';
const native = window.CasaNative;
const call = (action, value = '') => {
  if (native) native.action(action, value);
  else {
    $('error').hidden = false;
    $('error').textContent = 'Design preview only. Install the APK to record.';
  }
};
function show(name) {
  view = name;
  for (const section of ['welcome', 'form', 'confirm', 'session', 'camera-test'])
    $(section).hidden = section !== name;
}
$('setup').onclick = () => call('setup');
$('reenroll').onclick = () => call('reenroll');
$('begin').onclick = () => {
  if (!state.enabled || !state.tested) {
    call('setup');
    return;
  }
  show('form');
};
$('back').onclick = () => show('welcome');
$('edit').onclick = () => show('form');
function renderEmails() {
  $('email-count').textContent = `Registered emails (${emails.length}/4) · At least 1 is required.`;
  $('add-email').disabled = emails.length >= 4 || !$('player-email').value.trim();
  $('email-list').replaceChildren(...emails.map(address => {
    const chip = document.createElement('div');
    const label = document.createElement('span');
    const remove = document.createElement('button');
    label.textContent = address;
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${address}`);
    remove.onclick = () => {
      emails = emails.filter(value => value !== address);
      formError = '';
      renderEmails();
    };
    chip.append(label, remove);
    return chip;
  }));
}
function addEmail() {
  const value = $('player-email').value.trim().toLowerCase();
  if (emails.length >= 4) {
    formError = 'You can add a maximum of 4 Gmail accounts.';
    $('error').hidden = false;
    $('error').textContent = formError;
    return false;
  }
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value)) {
    formError = 'Enter a valid Gmail address.';
    $('error').hidden = false;
    $('error').textContent = formError;
    return false;
  }
  if (emails.includes(value)) {
    formError = 'That Gmail address is already added.';
    $('error').hidden = false;
    $('error').textContent = formError;
    return false;
  }
  emails.push(value);
  $('player-email').value = '';
  formError = '';
  $('error').hidden = true;
  renderEmails();
  return true;
}
$('player-email').oninput = () => {
  formError = '';
  renderEmails();
};
$('player-email').onkeydown = event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  addEmail();
};
$('add-email').onclick = addEmail;
$('email-form').onsubmit = event => {
  event.preventDefault();
  if ($('player-email').value.trim() && !addEmail()) return;
  if (!emails.length) {
    formError = 'Add at least one valid Gmail address.';
    $('error').hidden = false;
    $('error').textContent = formError;
    return;
  }
  formError = '';
  $('error').hidden = true;
  $('confirmation').textContent = `${state.court || 'Your court'} · One replay for every registered email`;
  $('confirmation-recipients').replaceChildren((() => {
    const card = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = 'Replay recipients';
    card.append(title);
    emails.forEach(value => {
      const item = document.createElement('span');
      item.textContent = value;
      card.append(item);
    });
    return card;
  })());
  $('capture-note').textContent = state.audio
    ? 'Video and available camera microphone audio will be recorded. The same Google Drive replay will be emailed to every address entered.'
    : 'Video will be recorded. The same Google Drive replay will be emailed to every address entered.';
  show('confirm');
};
$('record').onclick = () => {
  call('start', JSON.stringify(emails));
  $('player-email').value = '';
  emails = [];
  formError = '';
  renderEmails();
};
$('stop').onclick = () => call('stop');
$('camera-test-confirm').onclick = () => call('confirm-camera-test');
$('camera-test-retry').onclick = () => {
  const preview = $('camera-test-video');
  preview.pause();
  call('retry-camera-test');
};
$('reset').onclick = () => {
  call('reset');
  show('welcome');
};
function renderUploadStatus(queue) {
  const jobs = Array.isArray(queue) ? queue : [];
  const counts = {pending: 0, uploading: 0, completed: 0, failed: 0};
  jobs.forEach(item => {
    const status = String(item?.status || 'saved_locally');
    if (['saved_locally', 'pending', 'queued', 'retrying'].includes(status)) counts.pending++;
    else if (status === 'uploading') counts.uploading++;
    else if (['uploaded', 'complete', 'completed'].includes(status)) counts.completed++;
    else if (status === 'failed') counts.failed++;
  });
  $('queue-pending').textContent = String(counts.pending);
  $('queue-uploading').textContent = String(counts.uploading);
  $('queue-completed').textContent = String(counts.completed);
  $('queue-failed').textContent = String(counts.failed);
  $('queue-indicator').hidden = jobs.length === 0;
  return counts;
}
function tick() {
  try {
    state = native ? JSON.parse(native.state()) : {enabled: true, tested: true, court: 'Court 1', maxSeconds: 900, queue: []};
  } catch {
    return;
  }
  $('court').textContent = state.court || 'Not assigned';
  $('app-version').textContent = `Android recorder · ${state.version || 'preview'}`;
  const limitMinutes = Math.max(1, Math.round(Number(state.maxSeconds || 900) / 60));
  $('limit').textContent = `At least one Gmail address is required · Recording limit: ${limitMinutes} minutes`;
  $('setup').disabled = !!state.busy;
  $('record').disabled = !!state.busy;
  $('camera-test-confirm').disabled = !!state.busy;
  $('camera-test-retry').disabled = !!state.busy;
  const savedError = state.error === 'Select an Android camera mode for this device in the admin dashboard.'
    ? 'Open Device setup and choose this tablet’s camera.'
    : state.error;
  const currentError = savedError || formError;
  $('error').hidden = !currentError;
  $('error').textContent = currentError;
  const count = state.countdown || 0;
  $('count-in').hidden = count < 1;
  $('count-number').textContent = String(count || 3);
  const session = state.session;
  const activeServerSession = session && ['requested', 'starting', 'recording', 'finalizing'].includes(session.status);
  const recordingFlow = state.busy && ['connecting', 'countdown', 'recording', 'finalizing', 'testing'].includes(state.phase);
  if (state.testReady) {
    show('camera-test');
    if (lastTestToken !== state.testToken) {
      lastTestToken = state.testToken || String(Date.now());
      const preview = $('camera-test-video');
      preview.src = `https://appassets.androidplatform.net/camera-test/clip.mp4?v=${encodeURIComponent(lastTestToken)}`;
      preview.load();
    }
    $('camera-test-help').textContent = state.testHasAudio
      ? 'Turn the tablet volume up and confirm that court sounds or speech are clearly audible. This saved test clip is not muted.'
      : 'This configuration is video-only. Record another test after enabling audio if the final video should include sound.';
    $('camera-test-confirm').textContent = state.testHasAudio
      ? 'I can see and hear the test'
      : 'The video looks clear';
  } else if (recordingFlow || (activeServerSession && state.phase !== 'complete')) {
    show('session');
    $('session-title').textContent = state.phase === 'recording'
      ? 'Stay in the game.'
      : state.phase === 'testing' ? 'Testing your camera' : 'Your match';
    $('progress').textContent = state.message || 'Preparing your match…';
    const loading = ['connecting', 'testing', 'finalizing'].includes(state.phase);
    $('loading').hidden = !loading;
    $('loading').querySelector('b').textContent = state.phase === 'testing'
      ? 'Checking camera…'
      : state.phase === 'finalizing' ? 'Preparing saved video…' : 'Connecting to camera…';
    $('timer').hidden = state.phase !== 'recording';
    const remaining = Math.max(0, (state.maxSeconds || 900) - (state.elapsed || 0));
    $('timer').textContent = String(Math.floor(remaining / 60)).padStart(2, '0') + ':' + String(remaining % 60).padStart(2, '0');
    $('stop').hidden = state.phase !== 'recording';
    $('reset').hidden = true;
  } else if (view === 'session' || view === 'camera-test') {
    if (view === 'camera-test') {
      const preview = $('camera-test-video');
      preview.pause();
      preview.removeAttribute('src');
      preview.load();
      lastTestToken = '';
    }
    show('welcome');
  }
  const completion = state.phase === 'complete' && view === 'welcome';
  $('notice').classList.toggle('complete', completion);
  $('notice').textContent = !state.enabled
    ? state.enrolled
      ? 'Enrollment is saved. Open Device setup to retry the connection.'
      : 'Open Device setup and enter your enrollment code.'
    : !state.cameraMode
      ? 'This tablet is enrolled. Open Device setup to choose and test its camera.'
    : !state.tested
      ? 'Open Device setup and test the assigned camera before recording.'
      : view === 'welcome' ? (state.message || '') : '';
  renderUploadStatus(state.queue);
  if (state.initialized && !state.enabled && !state.enrolled && !enrollmentPrompted) {
    enrollmentPrompted = true;
    call('setup');
  }
}
tick();
renderEmails();
setInterval(tick, 750);
