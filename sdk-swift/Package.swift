// swift-tools-version:5.9
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "SynapseSDK",
    platforms: [
        .iOS(.v15),
        .macOS(.v12),
        .watchOS(.v8),
        .tvOS(.v15)
    ],
    products: [
        .library(
            name: "SynapseSDK",
            targets: ["SynapseSDK"]
        ),
    ],
    dependencies: [
        // Add any external dependencies here
    ],
    targets: [
        .target(
            name: "SynapseSDK",
            dependencies: [],
            path: "Sources/SynapseSDK"
        ),
        .testTarget(
            name: "SynapseSDKTests",
            dependencies: ["SynapseSDK"],
            path: "Tests/SynapseSDKTests"
        ),
    ]
)
