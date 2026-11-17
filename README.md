# Ամանորյա ադվենտ օրացույց — Railway

Киоск-календарь Yerevan Mall для собственного сервера (Railway). Аккаунт Claude на киоске не нужен.

## Что внутри

- `public/` — сама страница календаря (дизайн, двери, вихрь, карточка подарка) и картинки.
- `server.js` — сервер: хранит подарки и выигрыши, фото подарков, синхронизирует Google Sheet.
- Данные лежат в папке `/data` (Volume на Railway): `db.json` и папка `blobs/` с фото.

## Адреса

| Кто | Адрес | Что может |
|---|---|---|
| Киоск | `https://<ваш-адрес>/?key=<KIOSK_KEY>` (открыть один раз, ключ запоминается) | выдавать подарки, синхронизировать таблицу |
| Вы (админ) | `https://<ваш-адрес>/#admin` → пароль `ADMIN_PASSWORD` | всё: подарки, фото, эффект, сброс |
| Любой другой | `https://<ваш-адрес>/` | только смотреть, подарки не выдаются |

## Переменные (Railway → Variables)

| Переменная | Обязательно | Значение |
|---|---|---|
| `ADMIN_PASSWORD` | да | пароль для `#admin` |
| `KIOSK_KEY` | да | длинный секретный ключ для киоска, например `ym-advent-7Kq2x9Lp` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | для таблицы | всё содержимое JSON-ключа сервисного аккаунта Google |
| `SHEET_ID` | нет | ID таблицы, если хотите разрешить только её |

## Деплой

1. Загрузите эту папку в новый репозиторий на GitHub (можно через сайт: **Add file → Upload files**, перетащить все файлы и папки, кроме `node_modules` и `data`).
2. Railway → **New Project → Deploy from GitHub repo** → выберите репозиторий.
3. В сервисе: **Settings → Volumes → Add Volume**, путь монтирования `/data`.
4. **Variables**: добавьте `ADMIN_PASSWORD`, `KIOSK_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`.
5. **Settings → Networking → Generate Domain** — получите адрес вида `https://…up.railway.app`.

## Сервисный аккаунт Google (для таблицы)

1. https://console.cloud.google.com → создайте проект (например «YM Advent»).
2. **APIs & Services → Library**: включите **Google Sheets API** и **Google Drive API**.
3. **APIs & Services → Credentials → Create credentials → Service account** → любое имя → Done.
4. Откройте созданный аккаунт → **Keys → Add key → Create new key → JSON** — скачается файл.
5. Скопируйте всё содержимое файла в переменную `GOOGLE_SERVICE_ACCOUNT_JSON` на Railway.
6. В Google Sheet нажмите **Поделиться** и дайте почте сервисного аккаунта (`…@….iam.gserviceaccount.com`) права **Редактор**.

Фото подарков на Google Drive должны быть открыты как «Все, у кого есть ссылка».
