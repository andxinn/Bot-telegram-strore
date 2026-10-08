const TG_API = (token) => 'https://api.telegram.org/bot' + token

async function tgSendMessage(env, chatId, text, keyboard = null, parseMode = 'Markdown', messageThreadId = null, replyToMessageId = null) {
  const body = { chat_id: chatId, text, parse_mode: parseMode }
  if (keyboard) body.reply_markup = keyboard
  if (messageThreadId) body.message_thread_id = messageThreadId
  if (replyToMessageId) body.reply_parameters = { message_id: replyToMessageId }
  const res = await fetch(TG_API(env.BOT_TOKEN) + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
  return await res.json()
}

async function tgSendPhoto(env, chatId, photo, caption, keyboard = null, parseMode = 'Markdown', messageThreadId = null) {
  const body = { chat_id: chatId, photo, caption, parse_mode: parseMode }
  if (keyboard) body.reply_markup = keyboard
  if (messageThreadId) body.message_thread_id = messageThreadId
  const res = await fetch(TG_API(env.BOT_TOKEN) + '/sendPhoto', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
  return await res.json()
}

async function tgSendPhotoFile(env, chatId, photoFileId, caption, keyboard = null, parseMode = 'Markdown') {
  return await tgSendPhoto(env, chatId, photoFileId, caption, keyboard, parseMode)
}

async function tgSendPhotoUrl(env, chatId, photoUrl, caption, keyboard = null, parseMode = 'Markdown') {
  return await tgSendPhoto(env, chatId, photoUrl, caption, keyboard, parseMode)
}

async function tgEditMessageText(env, chatId, messageId, text, keyboard = null, parseMode = 'Markdown') {
  const body = { chat_id: chatId, message_id: messageId, text, parse_mode: parseMode }
  if (keyboard) body.reply_markup = keyboard
  const res = await fetch(TG_API(env.BOT_TOKEN) + '/editMessageText', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
  return await res.json()
}

async function tgEditMessageMedia(env, chatId, messageId, photo, caption, keyboard = null, parseMode = 'Markdown') {
  const body = {
    chat_id: chatId, message_id: messageId,
    media: JSON.stringify({ type: 'photo', media: photo, caption, parse_mode: parseMode })
  }
  if (keyboard) body.reply_markup = JSON.stringify(keyboard)
  const res = await fetch(TG_API(env.BOT_TOKEN) + '/editMessageMedia', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
  return await res.json()
}

async function tgEditMessageCaption(env, chatId, messageId, caption, keyboard = null, parseMode = 'Markdown') {
  const body = { chat_id: chatId, message_id: messageId, caption, parse_mode: parseMode }
  if (keyboard) body.reply_markup = keyboard
  const res = await fetch(TG_API(env.BOT_TOKEN) + '/editMessageCaption', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
  return await res.json()
}

async function tgDeleteMessage(env, chatId, messageId) {
  const res = await fetch(TG_API(env.BOT_TOKEN) + '/deleteMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, message_id: messageId })
  })
  return await res.json()
}

async function tgAnswerCallbackQuery(env, callbackQueryId, text = '', showAlert = false) {
  const body = { callback_query_id: callbackQueryId }
  if (text) { body.text = text; body.show_alert = showAlert }
  const res = await fetch(TG_API(env.BOT_TOKEN) + '/answerCallbackQuery', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
  return await res.json()
}

async function tgSendDocumentFile(env, chatId, documentFileId, caption = '', keyboard = null, parseMode = 'Markdown', messageThreadId = null) {
  const body = { chat_id: chatId, document: documentFileId, caption, parse_mode: parseMode }
  if (keyboard) body.reply_markup = keyboard
  if (messageThreadId) body.message_thread_id = messageThreadId
  const res = await fetch(TG_API(env.BOT_TOKEN) + '/sendDocument', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
  return await res.json()
}

async function tgSendDocument(env, chatId, fileContent, fileName, caption = '', keyboard = null, parseMode = 'Markdown', messageThreadId = null) {
  const formData = new FormData()
  formData.append('chat_id', chatId)
  formData.append('document', new Blob([fileContent], { type: 'text/plain' }), fileName)
  if (caption) formData.append('caption', caption)
  if (caption) formData.append('parse_mode', parseMode)
  if (keyboard) formData.append('reply_markup', JSON.stringify(keyboard))
  if (messageThreadId) formData.append('message_thread_id', messageThreadId)
  const res = await fetch(TG_API(env.BOT_TOKEN) + '/sendDocument', { method: 'POST', body: formData })
  return await res.json()
}

async function tgGetChat(env, chatId) {
  const res = await fetch(TG_API(env.BOT_TOKEN) + '/getChat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId })
  })
  return await res.json()
}

async function tgSendChatAction(env, chatId, action = 'typing') {
  const res = await fetch(TG_API(env.BOT_TOKEN) + '/sendChatAction', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, action })
  })
  return await res.json()
}

async function tgSetMyCommands(env, commands) {
  const res = await fetch(TG_API(env.BOT_TOKEN) + '/setMyCommands', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commands })
  })
  return await res.json()
}

async function tgSendPhotoBase64(env, chatId, base64String, caption, keyboard = null, parseMode = 'Markdown') {
  try {
    const raw = base64String.replace(/^data:image\/\w+;base64,/, '')
    const binaryStr = atob(raw)
    const bytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)
    const blob = new Blob([bytes], { type: 'image/jpeg' })
    const form = new FormData()
    form.append('chat_id', String(chatId))
    form.append('photo', blob, 'banner.jpg')
    if (caption) form.append('caption', caption)
    form.append('parse_mode', parseMode)
    if (keyboard) form.append('reply_markup', JSON.stringify(keyboard))
    const res = await fetch(TG_API(env.BOT_TOKEN) + '/sendPhoto', { method: 'POST', body: form })
    return await res.json()
  } catch (e) {
    return await tgSendMessage(env, chatId, caption || '📷 Foto', keyboard, parseMode)
  }
}


async function tgGetFile(env, fileId) {
  const res = await fetch(TG_API(env.BOT_TOKEN) + '/getFile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId })
  })
  const data = await res.json()
  if (!data.ok) return null
  return data.result // { file_id, file_path, file_size }
}

async function tgDownloadFile(env, filePath) {
  const url = 'https://api.telegram.org/file/bot' + env.BOT_TOKEN + '/' + filePath
  const res = await fetch(url)
  if (!res.ok) return null
  return await res.text()
}


async function tgSendSticker(env, chatId, sticker, keyboard = null) {
  const body = { chat_id: chatId, sticker }
  if (keyboard) body.reply_markup = keyboard
  const res = await fetch(TG_API(env.BOT_TOKEN) + '/sendSticker', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
  return await res.json()
}

async function tgCreateForumTopic(env, chatId, name) {
  const res = await fetch(TG_API(env.BOT_TOKEN) + '/createForumTopic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, name })
  })
  return await res.json()
}

async function tgCloseForumTopic(env, chatId, messageThreadId) {
  const res = await fetch(TG_API(env.BOT_TOKEN) + '/closeForumTopic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_thread_id: messageThreadId })
  })
  return await res.json()
}

async function tgReopenForumTopic(env, chatId, messageThreadId) {
  const res = await fetch(TG_API(env.BOT_TOKEN) + '/reopenForumTopic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_thread_id: messageThreadId })
  })
  return await res.json()
}

async function tgDeleteForumTopic(env, chatId, messageThreadId) {
  const res = await fetch(TG_API(env.BOT_TOKEN) + '/deleteForumTopic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_thread_id: messageThreadId })
  })
  return await res.json()
}

async function tgEditForumTopic(env, chatId, messageThreadId, name) {
  const res = await fetch(TG_API(env.BOT_TOKEN) + '/editForumTopic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_thread_id: messageThreadId, name })
  })
  return await res.json()
}

async function tgSetReaction(env, chatId, messageId, emoji = '🔥', isBig = true) {
  try {
    const res = await fetch(TG_API(env.BOT_TOKEN) + '/setMessageReaction', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji }], is_big: isBig })
    })
    return await res.json()
  } catch (e) { return null }
}

async function tgSendBanner(env, chatId, fileId, base64String, caption, keyboard = null, parseMode = 'Markdown') {
  if (fileId && String(fileId).length > 5) {
    try {
      const r = await tgSendPhoto(env, chatId, fileId, caption, keyboard, parseMode)
      if (r && r.ok) return r
    } catch (e) {}
  }
  if (base64String && base64String.length > 50) {
    return await tgSendPhotoBase64(env, chatId, base64String, caption, keyboard, parseMode)
  }
  return null
}

export {
  tgSendMessage, tgSendPhoto, tgSendPhotoFile, tgSendPhotoUrl, tgSendPhotoBase64, tgSendBanner, tgGetFile, tgDownloadFile, tgEditMessageText,
  tgEditMessageMedia, tgEditMessageCaption, tgDeleteMessage, tgAnswerCallbackQuery, tgSendDocument, tgSendDocumentFile,
  tgGetChat, tgSendChatAction, tgSetMyCommands, tgSendSticker, tgSetReaction,
  tgCreateForumTopic, tgCloseForumTopic, tgReopenForumTopic, tgDeleteForumTopic, tgEditForumTopic
}
