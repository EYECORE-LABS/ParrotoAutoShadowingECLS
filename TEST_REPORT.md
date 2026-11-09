# Kiểm thử Parroto Auto Shadowing 0.8.4

| Ca mô phỏng | Kết quả |
|---|---|
| Mở popup trên bài Parroto đã tải trước khi bật extension | Kết nối vào đúng trang và mở các nút điều khiển |
| Cài, cập nhật hoặc quay lại tab Parroto sau khi bật lại tiện ích | Nạp phần điều khiển còn thiếu vào trang hiện tại |
| Mở lại popup hoặc gửi nhiều yêu cầu kết nối | Dùng lại phần điều khiển đã sẵn sàng |
| Phiên mic cũ còn tồn tại sau khi cập nhật | Dọn phiên cũ và nhận lệnh của phiên mới |
| Tab đổi tài liệu trong khi kết nối | Chờ lần kết nối tiếp theo trên tài liệu mới |
| Mở popup ngoài Parroto | Giới hạn phần điều khiển ở Parroto |
| Ghi thủ công, chạy nền, quay lại câu đang dở và tự dừng sau câu cuối | Đạt kiểm thử hồi quy |

Đã kiểm tra cú pháp JavaScript, tài nguyên trong manifest và toàn vẹn ZIP. Các ca trên chạy bằng mô phỏng Node.js. Hành vi trên Chrome và Edge thật vẫn cần xác nhận.
