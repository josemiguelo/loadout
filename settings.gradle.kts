pluginManagement {
    repositories {
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        mavenCentral()
        google()
    }
}

rootProject.name = "loadout"

include(":model")
include(":dsl")
include(":gradle-plugin")
include(":core")
include(":app")
