# Parroto Auto Shadowing · EYECORE LABS

Phiên bản **0.8.4** dành cho Chrome và Edge Chromium 116 trở lên. Extension lấy câu tiếng Anh trong bài Shadowing và dùng Google TTS trực tuyến để đọc.

## Cài đặt

1. Giải nén ZIP.
2. Mở `edge://extensions` hoặc `chrome://extensions`, bật **Developer mode**.
3. Tắt bản Parroto Auto Shadowing cũ. Chọn **Load unpacked** và trỏ tới thư mục chứa `manifest.json`.
4. Nếu bài Parroto đã mở, quay lại tab đó và bấm biểu tượng extension. Extension kết nối ngay với trang hiện tại.

## Cách dùng

Mở popup trên bài Shadowing rồi chọn **Đầu ra giọng đọc**. Extension lưu lựa chọn cho các lượt sau. Sau khi bật lại hoặc cập nhật tiện ích, bạn có thể dùng tiếp bài đang mở.

| Chế độ | Đầu ra giọng đọc |
|---|---|
| **Loa ngoài + mic ảo** (mặc định) | Phát giọng ra thiết bị âm thanh của trình duyệt và đưa giọng vào bản ghi Parroto. |
| **Chỉ mic ảo** | Đưa giọng vào bản ghi Parroto. Có thể dùng nút phát lại của Parroto để nghe bản ghi. |

- **START AUTO** tiếp tục khi bạn chuyển sang tab khác. Giữ tab Parroto mở trong suốt lượt chạy.
- Nếu Parroto nhảy câu, extension quay về câu đang làm dở. Sau khi xác nhận toàn bộ câu, popup báo hoàn thành và lượt ghi tự động kết thúc.
- Extension xác nhận đúng thẻ trước khi ghi và chờ kết quả của câu đó trước khi chuyển tiếp. Mỗi câu có tối đa năm lượt thử.
- Nếu câu đang xử lý thiếu nội dung hoặc kết quả chưa xác nhận được, popup báo số câu cần kiểm tra.
- **ĐỌC KHI BẤM GHI ÂM** chuẩn bị mic ảo cho một lượt. Khi popup báo sẵn sàng, nhấn **Ghi âm** trên Parroto. Extension lấy câu tại thời điểm bấm và tự dừng sau khi đọc xong.
- **ĐỌC THỬ CÂU ĐANG HIỂN THỊ** dùng đầu ra đã chọn. Với chế độ **Chỉ mic ảo**, phần nghe trên loa sẽ im lặng.
- Nếu trình duyệt chờ mở âm thanh, nhấn một lần vào trang Parroto. **STOP** dừng lượt đang chạy hoặc hủy chế độ chờ ghi âm.
- Quét hình tab và giao diện tối đa **10 FPS**. Trước khi nhấn, extension kiểm tra lại nút trên giao diện hiện tại.

## Mic ảo

Cơ chế lấy mic ảo dựa trên bản `edge-tts-mic-v1.2.0`. Script chạy trong ngữ cảnh Parroto để chuyển yêu cầu `getUserMedia` sang luồng Web Audio. Audio MP3 được giải mã trong tab và cấp vào luồng này. Kết nối ra loa chỉ được tạo khi chọn **Loa ngoài + mic ảo**.

Google TTS cần Internet và dùng endpoint không chính thức. Khi gặp lỗi, mở popup và chọn **CHÉP NHẬT KÝ CHẨN ĐOÁN** để kiểm tra thông tin đầu ra, trạng thái mic và lỗi TTS.
