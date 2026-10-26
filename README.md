# MIA Milk Tracker — Backend

API Express lưu lịch sử uống sữa vào PostgreSQL. Cấu hình kết nối được đọc tự động từ `BE_MIA/.env` qua các biến `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE`.

## Chạy local

```bash
npm install
npm run dev
```

Server chạy tại `http://localhost:4002` theo cấu hình `.env`.

Khi khởi động, API tự tạo bảng `milk_entries` và index theo ngày nếu chưa tồn tại.

## API chính

- `GET /api/entries?date=YYYY-MM-DD`
- `GET /api/entries?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/summary?date=YYYY-MM-DD`
- `POST /api/entries`
- `PUT /api/entries/:id`
- `DELETE /api/entries/:id`
- `GET /api/pump-entries?date=YYYY-MM-DD`
- `POST /api/pump-entries`
- `PUT /api/pump-entries/:id`
- `DELETE /api/pump-entries/:id`
- `GET /api/sleep-entries?date=YYYY-MM-DD`
- `POST /api/sleep-entries`
- `PUT /api/sleep-entries/:id`
- `DELETE /api/sleep-entries/:id`
