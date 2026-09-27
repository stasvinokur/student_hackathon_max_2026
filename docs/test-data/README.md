# Тестовые данные

Все данные здесь **смоделированы** или **подготовлены заранее** (снимок OpenStreetMap для карты) для проверки решения;
реальных предпринимателей среди них нет.

| Что | Где | Зачем |
|---|---|---|
| Пакет правил «Кофейня / coffee-to-go, Казань» 1.1.2 | [content/kazan-coffee/pack.yaml](../../content/kazan-coffee/pack.yaml) | содержание маршрута; нормативные карточки помечены `test_data` до ручной проверки юристом |
| Эталонные профили и ожидаемые маршруты | [content/kazan-coffee/fixtures.yaml](../../content/kazan-coffee/fixtures.yaml) | 7 сценариев; в пяти дату не успеть (прогноз `projected_opening`) — в том числе открытие через месяц, сегодня и в прошлом; неподдерживаемый город; прогоняются тестами |
| Снимок индекса мест для раздела «Карта» | [content/kazan-coffee/location-index.json](../../content/kazan-coffee/location-index.json) | **подготовленные данные**, а не живые: реальный срез OpenStreetMap на 24.09.2026 (`dataStatus: prepared_snapshot`, ODbL); индекс мест — модельная оценка |
| Эталонные точки индекса мест | [content/kazan-coffee/location-fixtures.yaml](../../content/kazan-coffee/location-fixtures.yaml) | 7 мест Казани с ожидаемыми значениями; проверяются при сборке снимка и тестами |
| Тестовая учётная запись `demo_user` | [demo-profile.json](demo-profile.json) | MAX id 1000001 с построенным маршрутом для проверки API без клиента MAX |
| Контракт проверок API | [DATA-API.yaml](../../DATA-API.yaml) | роли, запросы, ожидаемые коды и поля |

## Учётные записи для проверки API

| Роль | MAX user id | Состояние |
|---|---|---|
| `demo_user` | 1000001 | маршрут построен, выполнены 2 шага из 19; открытие через 60 дней — не успеть, в маршруте прогноз |
| `new_user` | 1000002 | онбординг не пройден — API отвечает 404 `route_not_found` |

**Прогноз у demo_user — намеренно.** `seed-demo` ставит открытие через 60 дней, а этому профилю даже с выполненной
регистрацией нужно 66: аренда (30 дней) → оборудование помещения (30) → пожарная безопасность (5, закончить за день
до открытия). Поэтому `GET /api/route` отдаёт `projectedOpeningDate` — самую раннюю достижимую дату: в день `seed-demo`
на 6 дней позже `openingDate`, дальше на день позже каждый день, пока шаги цепочки не отмечены. Сроки шагов считаются
от неё, `lease-premises` — `overdue: true`. В мини-приложении под датой открытия — жёлтая плашка «К … не успеть — если
начать сегодня, откроетесь …», у аренды — «Просрочено — начните сегодня».

API принимает только подписанный `X-Max-Init-Data` (подпись токеном бота, как в клиенте MAX). Готовые значения
заголовка для обеих ролей — на первом (служебном) слайде презентации. Получить подпись самостоятельно:

```bash
# в контейнере стенда или локального docker compose (токен уже в окружении контейнера)
docker compose exec -T api node dist/scripts/sign-init-data.js 1000001
# создать или пересоздать demo_user с маршрутом
docker compose exec -T api node dist/scripts/seed-demo.js 1000001
```

## Примеры запросов

```bash
BASE=https://otkryvay.stasvinokur.ru
DEMO='<initData demo_user>'

curl -s $BASE/health
# {"status":"ok","db":"up","core":"0.1.0"}

curl -s -H "X-Max-Init-Data: $DEMO" $BASE/api/readiness
# {"done":2,"total":19,"percent":10,"criticalDone":1,"criticalTotal":9}

curl -s -H "X-Max-Init-Data: $DEMO" $BASE/api/tasks/lease-premises
# карточка: why, doNow, prepare, doneWhen, source {url, title, checkedAt}, kind: "test_data", places: []

curl -s -X PATCH -H "X-Max-Init-Data: $DEMO" -H 'Content-Type: application/json' \
  -d '{"status":"done"}' $BASE/api/tasks/get-ukep
# {"task":{…,"status":"done"},"readiness":{…},"nextStep":{…}}  — вернуть: {"status":"todo"}

curl -s -H "X-Max-Init-Data: $DEMO" $BASE/api/route
# маршрут: pack, openingDate, projectedOpeningDate (прогноз, см. выше), readiness, nextStep, blockers, lanes
# и places — 6 мест шагов (таблица ниже)

curl -s -H "X-Max-Init-Data: $DEMO" $BASE/api/config
# {"features":{"explain":false,"locationIndex":[{"pack":"kazan-coffee","version":"20260924T084102Z-53b5a120","actions":["lease-premises"]}]}}

# снимок индекса мест (≈ 477 КБ, со сжатием ≈ 77–80 КБ): заголовки ответа на экран, тело — в файл
curl -s --compressed -D - -o /tmp/location-index.json -H "X-Max-Init-Data: $DEMO" $BASE/api/packs/kazan-coffee/location-index
# 200; etag: "d493f2784cf32cef-gzip" (прокси стенда дописывает к ETag -gzip или -zstd); cache-control: private, no-cache

# повторный запрос с полученным ETag и тем же Accept-Encoding (--compressed оба раза) — 304 без тела
ETAG=$(curl -s --compressed -D - -o /dev/null -H "X-Max-Init-Data: $DEMO" $BASE/api/packs/kazan-coffee/location-index \
  | awk 'tolower($1) == "etag:" { print $2 }' | tr -d '\r')
curl -s --compressed -o /dev/null -w '%{http_code}\n' -H "X-Max-Init-Data: $DEMO" -H "If-None-Match: $ETAG" \
  $BASE/api/packs/kazan-coffee/location-index
# 304

curl -s $BASE/api/route
# 401 {"error":"unauthorized","message":"initData missing"}
```

## Места шагов на маршруте demo_user

`GET /api/route` отдаёт demo_user в `places` 6 мест — все места пакета, в порядке маршрута. Центр гигиены
(`cgie-rt`) привязан только к производственному контролю: шага с медкнижками в маршруте нет, потому что demo_user
работает без сотрудников. «Подпись на карте» — поле `shortName`, статусы шагов — после `seed-demo`.

| `id` места | Подпись на карте | Адрес | Шаг маршрута | Шаг у demo_user |
|---|---|---|---|---|
| `ifns-18-kazan` | ИФНС № 18 | Казань, ул. Владимира Кулагина, 1 | `register-business` | выполнен |
| `rospotrebnadzor-rt` | Роспотребнадзор | Казань, ул. Большая Красная, 30 | `rpn-notification` | не выполнен |
| `cgie-rt` | Центр гигиены | Казань, ул. Сеченова, 13а | `production-control` | не выполнен |
| `tko-operator-kazan` | Региональный оператор ТКО | Казань, ул. Щапова, 14/31 | `tko-contract` | не выполнен |
| `uag-kazan` | Управление архитектуры | Казань, ул. Груздева, 5 | `kazan-signage` | не выполнен |
| `my-business-kazan` | Центр «Мой бизнес» | Казань, ул. Петербургская, 28 | `support-consultation` | выполнен |

Следующий шаг demo_user — `lease-premises` («Найти и арендовать помещение, пригодное для общепита»). Своего места
у него нет, но он связан с индексом мест (`features.locationIndex[].actions`), поэтому в его карточке есть «Подобрать
район на карте». `GET /api/tasks/rpn-notification` отдаёт одно место — Роспотребнадзор (проверка `task_with_places`
в DATA-API.yaml).
