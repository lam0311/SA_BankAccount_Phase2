# Báo cáo đánh giá kiến trúc và đánh đổi kỹ thuật

Tài liệu ghi chép các đánh đổi kỹ thuật, bài học rút ra và định hướng phát triển của nhóm trong quá trình hiện thực hóa hệ thống Bank Account.

## 1. Lý do lựa chọn kiến trúc và các đánh đổi kỹ thuật

### 1.1. Modular monolith thay vì Microservices
– **Quyết định:** Gom toàn bộ 3 bounded context `identity`, `accounts`, `money-movement` vào một ứng dụng NestJS duy nhất và dùng chung một instance PostgreSQL.  
– **Lý do lựa chọn:**  
  – Ở quy mô nghiệp vụ hiện tại, tính toàn vẹn của giao dịch chuyển khoản đòi hỏi tính nguyên tử tuyệt đối. Trong Modular Monolith, nhóm có thể thực thi trọn vẹn nghiệp vụ này bằng một database transaction duy nhất.  
  – Nếu chia thành Microservices, nhóm sẽ phải đối mặt với bài toán giao dịch phân tán, buộc phải áp dụng Saga pattern, Outbox pattern và Event Broker với tính nhất quán cuối cùng. Điều này làm tăng độ phức tạp vận hành và rủi ro mất cân đối số dư tạm thời ngoài phạm vi yêu cầu của đồ án.  
– **Đánh đổi:** Cả 3 module phải scale cùng nhau. Nếu module `identity` bị nghẽn CPU do Bcrypt, toàn bộ instance ứng dụng bị ảnh hưởng. Tuy nhiên, nhờ tổ chức mã nguồn theo Clean Architecture và phân tách ranh giới module chặt chẽ qua Port và Adapter, việc tách thành các service riêng biệt trong tương lai là hoàn toàn khả thi mà không cần viết lại tầng Domain.  

### 1.2. Khóa dòng bi quan thay vì khóa lạc quan
– **Quyết định:** Sử dụng câu lệnh SQL `SELECT ... FOR UPDATE` trực tiếp tại thời điểm bắt đầu giao dịch nạp, rút hoặc chuyển tiền.  
– **Lý do lựa chọn:**  
  – Trong lĩnh vực tài chính ngân hàng, việc cho phép giao dịch ghi thất bại rồi bắt người dùng thử lại nhiều lần khi có xung đột cao mang lại trải nghiệm rất kém.  
  – Khóa bi quan ép các tiến trình cùng thao tác trên một tài khoản phải xếp hàng tuần tự trong hàng đợi của PostgreSQL, đảm bảo khi một giao dịch được xử lý, nó luôn đọc được số dư thực tế mới nhất.  
– **Đánh đổi:** Độ trễ ở đuôi phân vị cao như p95 và p99 tăng lên khi có nhiều request đồng thời vào cùng một tài khoản. Nhóm chấp nhận đánh đổi thời gian chờ đợi này để đổi lấy tính an toàn dữ liệu tuyệt đối.  

### 1.3. Sắp xếp thứ tự khóa để loại bỏ deadlock
– **Vấn đề:** Khi tài khoản A chuyển tiền cho B, đồng thời tài khoản B chuyển tiền cho A:  
  – Tiến trình 1 khóa A, chờ khóa B.  
  – Tiến trình 2 khóa B, chờ khóa A.  
  – Cơ sở dữ liệu rơi vào bế tắc và một trong hai tiến trình bị hủy đột ngột.  
– **Giải pháp của nhóm:** Trong `TransferMoneyUseCase`, trước khi xin khóa, hệ thống luôn so sánh ID tài khoản và sắp xếp:  
  $$\text{firstId} = \min(\text{sourceId}, \text{destId}), \quad \text{secondId} = \max(\text{sourceId}, \text{destId})$$
  Cả hai tiến trình đều buộc phải xin khóa `firstId` trước rồi mới xin khóa `secondId`. Tiến trình nào đến trước sẽ giữ khóa đầu tiên, tiến trình kia tự động chờ ở ngoài, triệt tiêu hoàn toàn khả năng xảy ra chu trình chờ đợi lẫn nhau.

### 1.4. Tách biệt Đọc/Ghi (CQRS) kết hợp Multi-level Cache cho phân hệ Accounts
– **Quyết định:** Tách rời hoàn toàn `AccountRepositoryPort` cũ thành `AccountCommandRepositoryPort` (nhánh ghi) và `AccountQueryRepositoryPort` (nhánh đọc trả `AccountReadModel` phẳng qua L1 In-Memory LRU + L2 Redis).  
– **Lý do lựa chọn:**  
  – Trong hệ thống ngân hàng, tần suất người dùng mở app xem số dư và danh sách tài khoản cao gấp nhiều lần tần suất mở hoặc đóng tài khoản. Việc dùng Read Model phẳng giúp bỏ qua hoàn toàn chi phí khởi tạo Domain Entity và Value Object `Money` (`bigint`) khi phục vụ từ cache.  
  – Ngược lại, nếu bọc cache chung cho cả nhánh ghi, thao tác đóng tài khoản (`CloseAccountHandler`) có nguy cơ đọc phải số dư cũ trong cache. Tách riêng Command Repository bắt buộc nhánh ghi luôn kiểm tra trực tiếp trên Primary PostgreSQL.  
– **Đánh đổi và cách xử lý:** Lưu cache số dư tài khoản làm nảy sinh nguy cơ *stale balance* khi giao dịch phát sinh ở module `money-movement`. Nhóm giải quyết bằng cơ chế **Post-Commit Cache Invalidation** trong `PrismaUnitOfWork`: theo dõi các tài khoản bị cập nhật số dư trong transaction và chỉ phát lệnh xóa cache L1/L2 sau khi PostgreSQL đã `COMMIT` thành công.  

### 1.5. Thiết kế Health Check phân tầng (Critical vs Soft Degradation)
– **Quyết định:** Xây dựng endpoint `GET /api/v1/health` kiểm tra song song PostgreSQL, Redis, Piscina Worker Pool và độ trễ Outbox, nhưng phân biệt rạch ròi giữa lỗi sống còn (`503 Service Unavailable`) và suy giảm mềm (`200 OK` kèm `status: "DEGRADED"`).  
– **Lý do lựa chọn:**  
  – Nếu gộp mọi sự cố phụ trợ (như mất kết nối Redis cache hoặc trễ hàng đợi Outbox) thành mã lỗi `503`, Docker hoặc Kubernetes sẽ đánh dấu container `unhealthy` và khởi động lại hàng loạt (*cascading restart*), làm sập toàn bộ hệ thống trong khi ứng dụng thực tế vẫn giao dịch bình thường nhờ cơ chế fallback về L1 LRU và PostgreSQL.  
  – Chỉ khi thành phần sống còn (`postgres` hoặc `piscina` worker pool) ngừng hoạt động (`DOWN`), hệ thống mới trả `503` để ngắt lưu lượng điều phối vào instance lỗi.  

## 2. Rà soát thực tế so với thiết kế ban đầu

| Tiêu chí | Thiết kế lý thuyết ban đầu | Hiện thực hóa trong mã nguồn | Đánh giá & Ghi chú thực tế |
| :--- | :--- | :--- | :--- |
| **Bảo toàn số dư** | Trừ tiền nguồn, cộng tiền đích | Bọc trọn vẹn trong `UnitOfWorkPort` | Hoạt động chính xác, rollback toàn bộ nếu có lỗi phát sinh giữa chừng. |
| **Xử lý số âm** | Kiểm tra số dư khả dụng | Kiểm tra kép: ở tầng Application và CHECK constraint ở PostgreSQL | Phòng vệ hai lớp, chặn đứng tình trạng thấu chi. |
| **Idempotency** | Gửi lại cùng key trả kết quả cũ | Lưu ràng buộc duy nhất trên cặp `(source_account_id, idempotency_key)` | Chống trừ tiền trùng lặp hiệu quả khi client bị timeout hoặc mạng chập chờn. |
| **Kiểm tra quyền sở hữu** | Kiểm tra quyền trên từng route | `AccessTokenGuard` trích xuất danh tính, Use Case / Handler so khớp `userId` | Trả về 404 thay vì 403 để không tiết lộ sự tồn tại của tài khoản người khác. |
| **Lịch sử giao dịch** | Ghi nhận biến động số dư | Mỗi giao dịch ghi kèm `balanceAfter` | Dữ liệu sổ cái bất biến, phục vụ đối soát và kiểm toán tài chính. |
| **Hiệu năng băm mật khẩu** | Đăng ký và đăng nhập an toàn | Bcrypt chi phí 12 chạy trên Piscina Worker Thread Pool | Giải phóng hoàn toàn Event Loop chính để không làm nghẽn các API đọc/ghi khác dưới tải đăng nhập cao. |
| **Tối ưu luồng đọc tài khoản** | Tách biệt đọc/ghi (CQRS) & Cache | `CachedAccountQueryRepository` (L1 LRU + L2 Redis) + xóa cache sau commit | Giảm tải đáng kể cho PostgreSQL mà vẫn tránh được hiện tượng đọc số dư cũ (*stale balance*). |
| **Khả năng quan sát hạ tầng** | Health Check toàn diện | `HealthService` kiểm tra song song Postgres, Redis, Piscina & Outbox lag | Phân biệt rõ `OK`, `DEGRADED` (`200`) và `DOWN` (`503`), tích hợp trực tiếp vào Docker `HEALTHCHECK`. |

## 3. Các giới hạn hiện tại và hướng nâng cấp

Dù hệ thống đã giải quyết trọn vẹn các yêu cầu cốt lõi của Giai đoạn 1, nhóm cũng tự đánh giá một số điểm có thể mở rộng thêm trong thực tế:
1. **Kiểm tra Payload Hash trong Idempotency:** Hiện tại hệ thống đối chiếu theo cặp tài khoản nguồn và key. Hướng nâng cấp tiếp theo là lưu thêm mã băm SHA-256 của Request Body để báo lỗi nếu client cố tình dùng cùng một key nhưng thay đổi số tiền hoặc tài khoản nhận.
2. **Cơ chế Phân trang Keyset:** API xem lịch sử giao dịch hiện dùng phân trang dạng offset và limit. Với bảng giao dịch hàng triệu dòng, nên chuyển sang phân trang bằng con trỏ để tối ưu tốc độ quét index.
3. **Trigger cấm sửa hoặc xóa trực tiếp trên bảng sổ cái:** Hiện tại API không có endpoint nào sửa hay xóa bảng `financial_transactions`. Tuy nhiên, để ngăn chặn cả quyền can thiệp trực tiếp của quản trị viên database, có thể viết thêm PostgreSQL Trigger để cấm cập nhật hoặc xóa dòng trong bảng này.
