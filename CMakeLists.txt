cmake_minimum_required(VERSION 3.20)

project(nexus_ai_lab VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(CTest)
find_package(Boost 1.74 REQUIRED COMPONENTS system)
find_package(Threads REQUIRED)
find_package(nlohmann_json 3.11 REQUIRED)

add_library(nexus_core
    backend/src/http_server.cpp
    backend/src/sse_hub.cpp
    backend/src/task_manager.cpp
)

target_include_directories(nexus_core
    PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}/backend/include
)

target_link_libraries(nexus_core
    PUBLIC
        Boost::system
        Threads::Threads
        nlohmann_json::nlohmann_json
)

if (UNIX)
    target_compile_definitions(nexus_core PRIVATE BOOST_ERROR_CODE_HEADER_ONLY)
endif()

add_executable(nexus-server backend/src/main.cpp)
target_link_libraries(nexus-server PRIVATE nexus_core)

if (BUILD_TESTING)
    add_executable(nexus-smoke backend/tests/smoke.cpp)
    target_link_libraries(nexus-smoke PRIVATE nexus_core)
    add_test(NAME nexus_smoke COMMAND nexus-smoke)

    add_executable(nexus-sse-regression backend/tests/sse_regression.cpp)
    target_link_libraries(nexus-sse-regression PRIVATE nexus_core)
    add_test(NAME nexus_sse_regression COMMAND nexus-sse-regression)

    if (UNIX)
        add_test(
            NAME nexus_http_contract
            COMMAND bash ${CMAKE_CURRENT_SOURCE_DIR}/backend/tests/http_contract.sh
                    $<TARGET_FILE:nexus-server>
        )
        set_tests_properties(nexus_http_contract PROPERTIES TIMEOUT 15)
    endif()
endif()
